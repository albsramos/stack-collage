import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeAudio,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { computeSlots, mediaRect, type Format, type LayoutOpts, type Rect, type Transform } from './layout';
import type { Media } from './media';

export interface SlotState {
  media: Media | null;
  t: Transform;
}

export interface ExportOpts {
  format: Format;
  layout: LayoutOpts;
  slots: SlotState[];
  background: string;
  scale: 1 | 2; // 1 = 1080 wide (Instagram native), 2 = 2160 wide
  audioFrom: number | null; // slot index or null for silent
  maxDuration: number; // seconds
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  warning?: string;
}

const FPS = 30;

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

function scaleRect(r: Rect, k: number): Rect {
  return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
}

function clipSlot(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  if (radius > 0 && 'roundRect' in ctx) ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  else ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  o: ExportOpts,
  rects: Rect[],
  sources: (CanvasImageSource | null)[],
) {
  const k = o.scale;
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  o.slots.forEach((s, i) => {
    const src = sources[i];
    const r = scaleRect(rects[i], k);
    ctx.save();
    clipSlot(ctx, r, o.layout.radius * k);
    if (s.media && src) {
      const d = mediaRect(r, s.media.w, s.media.h, s.t);
      ctx.drawImage(src, d.x, d.y, d.w, d.h);
    } else {
      ctx.fillStyle = '#1c1c1e';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  });
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function hasVideo(slots: SlotState[]) {
  return slots.some((s) => s.media?.kind === 'video');
}

export async function exportCollage(o: ExportOpts): Promise<ExportResult> {
  return hasVideo(o.slots) ? exportVideo(o) : exportImage(o);
}

async function exportImage(o: ExportOpts): Promise<ExportResult> {
  const W = o.format.w * o.scale;
  const H = o.format.h * o.scale;
  const { c, ctx } = makeCanvas(W, H);
  const rects = computeSlots(o.format, o.layout);
  drawFrame(ctx, o, rects, o.slots.map((s) => s.media?.image ?? null));
  o.onProgress?.(1);
  const blob = await new Promise<Blob>((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/jpeg', 0.95),
  );
  return { blob, filename: `collage-${stamp()}.jpg` };
}

interface VideoFeed {
  next(): Promise<CanvasImageSource | null>;
  close(): Promise<void>;
}

async function openVideoFeed(media: Media, rect: Rect, s: SlotState, total: number): Promise<VideoFeed> {
  const input = new Input({ source: new BlobSource(media.file), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  // Decode straight to the size we'll draw at — sharper than letting drawImage downscale a 4K frame, and lighter on memory.
  const d = mediaRect(rect, media.w, media.h, s.t);
  const sink = new CanvasSink(track, {
    width: Math.max(2, Math.round(d.w)),
    height: Math.max(2, Math.round(d.h)),
    fit: 'fill',
    poolSize: 3,
  });
  const loopLen = Math.max(media.duration, 1 / FPS);
  function* times() {
    for (let f = 0; f < total; f++) {
      const t = (f / FPS) % loopLen;
      // Stay a hair inside the clip so the last frame is always found.
      yield Math.min(t, Math.max(0, loopLen - 1 / (FPS * 4)));
    }
  }
  const it = sink.canvasesAtTimestamps(times());
  let last: CanvasImageSource | null = null;
  return {
    async next() {
      const r = await it.next();
      const w = r.value as WrappedCanvas | null | undefined;
      if (w) last = w.canvas as CanvasImageSource;
      return last;
    },
    async close() {
      await it.return?.(undefined);
      input.dispose?.();
    },
  };
}

/**
 * Find a codec + bitrate the device's encoder actually accepts. iOS Safari rejects some bitrates at a given
 * resolution, so check the exact config we'll use (codec, size, bitrate, frame rate) and step the bitrate down
 * until one passes, before falling back to HEVC.
 */
async function pickVideoEncoding(width: number, height: number, k: number) {
  // ~16 Mbps at 1080×1920 is well above what Instagram keeps, so their re-encode starts from a clean master.
  // Lower rungs still look fine; the first one the encoder accepts wins.
  const mbps = [16, 12, 10, 8, 6, 4];
  const codecs: VideoCodec[] = ['avc', 'hevc'];
  for (const codec of codecs) {
    for (const m of mbps) {
      const bitrate = Math.round(m * 1_000_000 * k * k);
      const ok = await canEncodeVideo(codec, { width, height, bitrate, frameRate: FPS }).catch(() => false);
      if (ok) return { codec, bitrate };
    }
  }
  return null;
}

async function exportVideo(o: ExportOpts): Promise<ExportResult> {
  const k = o.scale;
  const W = o.format.w * k;
  const H = o.format.h * k;
  const rects = computeSlots(o.format, o.layout);
  const longest = Math.max(...o.slots.map((s) => (s.media?.kind === 'video' ? s.media.duration : 0)));
  const duration = Math.min(longest, o.maxDuration);
  const total = Math.max(1, Math.round(duration * FPS));

  const enc = await pickVideoEncoding(W, H, k);
  if (!enc) {
    throw new Error(
      k > 1
        ? `This device can't encode ${W}×${H} video. Switch Size to Standard and try again.`
        : `This device can't encode ${W}×${H} video.`,
    );
  }

  const { c, ctx } = makeCanvas(W, H);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoSource = new CanvasSource(c, {
    codec: enc.codec,
    bitrate: enc.bitrate,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });

  // Optional audio from one video slot.
  let warning: string | undefined;
  let audioTask: (() => Promise<void>) | null = null;
  const audioMedia = o.audioFrom !== null ? o.slots[o.audioFrom]?.media : null;
  if (audioMedia?.kind === 'video' && audioMedia.hasAudio) {
    // Instagram wants AAC. If the browser can't encode it natively, lazy-load a WASM AAC encoder.
    if (!(await canEncodeAudio('aac'))) {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
    }
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 });
    if (!audioCodec) {
      warning = "This browser can't encode audio, so the video was saved without sound.";
    } else {
      const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
      output.addAudioTrack(audioSource);
      audioTask = async () => {
        const input = new Input({ source: new BlobSource(audioMedia.file), formats: ALL_FORMATS });
        try {
          const track = (await input.getPrimaryAudioTrack())!;
          const sink = new AudioBufferSink(track);
          let written = 0;
          // Loop the clip's audio, like the picture, until the output duration is filled.
          while (written < duration - 1e-3) {
            let wroteThisPass = 0;
            for await (const { buffer } of sink.buffers(0, audioMedia.duration)) {
              if (o.signal?.aborted) return;
              const remaining = duration - written;
              if (remaining <= 1e-3) break;
              let b = buffer;
              if (b.duration > remaining) b = trimAudio(b, remaining);
              await audioSource.add(b);
              written += b.duration;
              wroteThisPass += b.duration;
            }
            if (wroteThisPass === 0) break;
          }
        } finally {
          audioSource.close();
          input.dispose?.();
        }
      };
    }
  }

  await output.start();

  const feeds: (VideoFeed | null)[] = await Promise.all(
    o.slots.map((s, i) =>
      s.media?.kind === 'video' ? openVideoFeed(s.media, scaleRect(rects[i], k), s, total) : Promise.resolve(null),
    ),
  );

  const videoTask = async () => {
    try {
      for (let f = 0; f < total; f++) {
        if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const frames = await Promise.all(
          o.slots.map((s, i) => (feeds[i] ? feeds[i]!.next() : Promise.resolve(s.media?.image ?? null))),
        );
        drawFrame(ctx, o, rects, frames);
        await videoSource.add(f / FPS, 1 / FPS);
        o.onProgress?.((f + 1) / total);
      }
    } finally {
      videoSource.close();
      await Promise.all(feeds.map((f) => f?.close()));
    }
  };

  try {
    // Feed both tracks concurrently — the muxer interleaves them and applies backpressure.
    await Promise.all([videoTask(), audioTask?.()]);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }

  const buf = (output.target as BufferTarget).buffer!;
  return { blob: new Blob([buf], { type: 'video/mp4' }), filename: `collage-${stamp()}.mp4`, warning };
}

function trimAudio(b: AudioBuffer, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * b.sampleRate));
  const out = new AudioBuffer({ length: len, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    out.copyToChannel(b.getChannelData(ch).subarray(0, len), ch);
  }
  return out;
}

/** Hand the file to the OS share sheet (→ “Save Image/Video” on iOS) or fall back to a download. */
export async function saveResult(r: ExportResult): Promise<'shared' | 'downloaded' | 'cancelled'> {
  // Hosted inside a claude.ai artifact: the sandbox blocks downloads/Web Share, so use its downloads capability.
  const host = (window as unknown as { claude?: { use(n: string): Promise<any> } }).claude;
  if (host) {
    const dl = await host.use('downloads').catch(() => null);
    if (dl) {
      try {
        await dl.save({ filename: r.filename, data: r.blob });
        return 'downloaded';
      } catch (e) {
        if ((e as { code?: string }).code === 'declined') return 'cancelled';
        throw new Error((e as { message?: string }).message ?? 'Save failed');
      }
    }
  }
  const file = new File([r.blob], r.filename, { type: r.blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(r.blob);
  a.download = r.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return 'downloaded';
}
