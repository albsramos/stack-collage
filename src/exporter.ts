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
  StreamTarget,
  type Target,
  type VideoCodec,
  canEncodeAudio,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { clamp, computeSlots, mediaRect, type Format, type LayoutOpts, type Rect, type Transform } from './layout';
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
  /** 0…1, plus a label when the phase changes (e.g. "Finishing…"). */
  onProgress?: (p: number, label?: string) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  warning?: string;
  /** Frees what backs `blob` (an on-disk file for video). Call once the result is no longer shown or saved. */
  release?: () => Promise<void>;
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

/** What to draw in a slot. `cropped` sources already hold exactly the slot's visible area. */
type SlotSource = { src: CanvasImageSource; cropped: boolean } | null;

function drawBackground(ctx: CanvasRenderingContext2D, o: ExportOpts) {
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Draw the slots `only` selects (all by default). Slots never overlap, so each can be redrawn on its own. */
function drawSlots(
  ctx: CanvasRenderingContext2D,
  o: ExportOpts,
  rects: Rect[],
  sources: SlotSource[],
  only: (i: number) => boolean = () => true,
  repaint = false,
) {
  const k = o.scale;
  o.slots.forEach((s, i) => {
    if (!only(i)) return;
    const src = sources[i];
    const r = scaleRect(rects[i], k);
    // Redrawing over the last frame: reset the slot's box first, or antialiased rounded corners would blend with
    // every previous frame instead of the background.
    if (repaint) {
      ctx.fillStyle = o.background;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.save();
    clipSlot(ctx, r, o.layout.radius * k);
    if (s.media && src?.cropped) {
      ctx.drawImage(src.src, r.x, r.y, r.w, r.h);
    } else if (s.media && src) {
      const d = mediaRect(r, s.media.w, s.media.h, s.t);
      ctx.drawImage(src.src, d.x, d.y, d.w, d.h);
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

const photoSource = (s: SlotState): SlotSource => (s.media?.image ? { src: s.media.image, cropped: false } : null);

function hasVideo(slots: SlotState[]) {
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
  drawBackground(ctx, o);
  drawSlots(ctx, o, rects, o.slots.map(photoSource));
  o.onProgress?.(1);
  const blob = await new Promise<Blob>((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/jpeg', 0.95),
  );
  return { blob, filename: `collage-${stamp()}.jpg` };
}

interface VideoFeed {
  next(): Promise<SlotSource>;
  close(): Promise<void>;
}

/** Length of one pass of a looping clip. Picture and sound both loop on this, so they stay in sync. */
const loopLength = (m: Media) => Math.max(m.duration, 1 / FPS);

/** The part of the media visible in a slot, in the media's own (display) pixels, rounded to whole pixels. */
function visibleCrop(rect: Rect, m: Media, t: Transform) {
  const d = mediaRect(rect, m.w, m.h, t);
  const k = m.w / d.w;
  const left = clamp(Math.round((rect.x - d.x) * k), 0, m.w - 1);
  const top = clamp(Math.round((rect.y - d.y) * k), 0, m.h - 1);
  return {
    left,
    top,
    width: clamp(Math.round(rect.w * k), 1, m.w - left),
    height: clamp(Math.round(rect.h * k), 1, m.h - top),
  };
}

async function openVideoFeed(media: Media, rect: Rect, s: SlotState, total: number): Promise<VideoFeed> {
  const input = new Input({ source: new BlobSource(media.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`No video track in “${media.file.name}”.`);
    // Decode only the visible part, at the slot's size but never above the source's own resolution. Decoding the
    // whole zoomed frame could ask for a canvas far beyond iOS's ~16.7 MP limit (5× zoom at 2× output), which fails.
    const crop = visibleCrop(rect, media, s.t);
    const k = Math.min(1, crop.width / rect.w);
    const sink = new CanvasSink(track, {
      crop,
      width: Math.max(2, Math.round(rect.w * k)),
      height: Math.max(2, Math.round(rect.h * k)),
      fit: 'fill',
      poolSize: 3,
    });
    const loopLen = loopLength(media);
    function* times() {
      for (let f = 0; f < total; f++) {
        // Stay a hair inside the clip so the last frame is always found.
        const t = Math.min((f / FPS) % loopLen, Math.max(0, loopLen - 1 / (FPS * 4)));
        yield media.start + t;
      }
    }
    const it = sink.canvasesAtTimestamps(times());
    let last: SlotSource = null;
    return {
      async next() {
        const r = await it.next();
        const w = r.value as WrappedCanvas | null | undefined;
        if (w) last = { src: w.canvas as CanvasImageSource, cropped: true };
        return last;
      },
      async close() {
        await it.return?.(undefined);
        input.dispose?.();
      },
    };
  } catch (e) {
    input.dispose?.();
    throw e;
  }
}

async function exportVideo(o: ExportOpts): Promise<ExportResult> {
  const k = o.scale;
  const W = o.format.w * k;
  const H = o.format.h * k;
  const longest = Math.max(...o.slots.map((s) => (s.media?.kind === 'video' ? s.media.duration : 0)));
  const duration = Math.min(longest, o.maxDuration);
  const total = Math.max(1, Math.round(duration * FPS));

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc'], { width: W, height: H });
  if (!videoCodec) throw new Error(`This browser can't encode ${W}×${H} video. Try the Standard size.`);

  const sink = await openOutputFile();
  try {
    const { warning } = await encodeVideo(o, sink, videoCodec, duration, total);
    // Cancel tapped during "Finishing…": the file is complete, but the user asked to stop.
    if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    return { blob: await sink.result(), filename: `collage-${stamp()}.mp4`, warning, release: sink.discard };
  } catch (e) {
    await sink.discard(); // whatever failed — setup included — leaves no file behind
    throw e;
  }
}

async function encodeVideo(
  o: ExportOpts,
  sink: OutputFile,
  videoCodec: VideoCodec,
  duration: number,
  total: number,
): Promise<{ warning?: string }> {
  const k = o.scale;
  const rects = computeSlots(o.format, o.layout);
  const { c, ctx } = makeCanvas(o.format.w * k, o.format.h * k);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  const videoSource = new CanvasSource(c, {
    codec: videoCodec,
    // ~16 Mbps at 1080×1920 — well above what Instagram keeps, so their re-encode starts from a clean master.
    // At 2× this grows by k^1.5 (~45 Mbps), not k² (64 Mbps): the extra bits buy little once the encoder has 4× the
    // pixels to spend them on, and a 60 s 2× file stays ~340 MB instead of ~480 MB.
    bitrate: Math.round(16_000_000 * k ** 1.5),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });

  // One controller for both tracks: the user's Cancel, or a failure in either track, stops the other one too.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  const checkAborted = () => {
    if (stop.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  };
  // Progress is the slower of the two tracks, so the bar doesn't sit at 100% while sound is still encoding.
  let videoDone = 0;
  let audioDone = 1;
  const report = () => o.onProgress?.(Math.min(videoDone, audioDone));

  // Optional audio from one video slot.
  let warning: string | undefined;
  let audioTask: (() => Promise<void>) | null = null;
  const audioMedia = o.audioFrom !== null ? o.slots[o.audioFrom]?.media : null;
  if (audioMedia?.kind === 'video' && audioMedia.hasAudio) {
    const audioCodec = await pickAudioCodec();
    if (!audioCodec) {
      warning = "This browser can't encode audio, so the video was saved without sound.";
    } else {
      // Resample/remix to what the encoder was probed with: a mono or 44.1 kHz clip then can't fail a config the
      // probe never checked.
      const audioSource = new AudioBufferSource({
        codec: audioCodec,
        bitrate: QUALITY_HIGH,
        transform: { sampleRate: 48000, numberOfChannels: 2 },
      });
      output.addAudioTrack(audioSource);
      audioDone = 0;
      audioTask = async () => {
        const input = new Input({ source: new BlobSource(audioMedia.file), formats: ALL_FORMATS });
        try {
          const track = await input.getPrimaryAudioTrack();
          if (!track) {
            audioDone = 1;
            return;
          }
          await writeLoopedAudio(audioSource, new AudioBufferSink(track), audioMedia, duration, checkAborted, (p) => {
            audioDone = p;
            report();
          });
        } finally {
          audioSource.close();
          input.dispose?.();
        }
      };
    }
  }

  const feeds: (VideoFeed | null)[] = o.slots.map(() => null);
  const isVideo = (i: number) => feeds[i] !== null;
  const videoTask = async () => {
    try {
      // Photos don't change: draw them once and from then on redraw only the video slots. Downscaling a 12–48 MP
      // photo 1,800 times (60 s × 30 fps) was most of the per-frame work.
      drawBackground(ctx, o);
      drawSlots(ctx, o, rects, o.slots.map(photoSource), (i) => !isVideo(i));
      for (let f = 0; f < total; f++) {
        checkAborted();
        const frames = await Promise.all(o.slots.map((_, i) => feeds[i]?.next() ?? null));
        drawSlots(ctx, o, rects, frames, isVideo, true);
        await videoSource.add(f / FPS, 1 / FPS);
        videoDone = (f + 1) / total;
        report();
      }
    } finally {
      videoSource.close();
    }
  };
  const run = async (task: () => Promise<void>) => {
    try {
      await task();
    } catch (e) {
      stop.abort();
      throw e;
    }
  };

  o.signal?.addEventListener('abort', onAbort, { once: true });
  if (o.signal?.aborted) stop.abort(); // Cancel was tapped while we were still setting up
  try {
    await output.start();
    // Open the feeds one by one, so if one fails the ones already opened are still closed below.
    for (let i = 0; i < o.slots.length; i++) {
      const s = o.slots[i];
      if (s.media?.kind === 'video') feeds[i] = await openVideoFeed(s.media, scaleRect(rects[i], k), s, total);
    }
    // Feed both tracks concurrently — the muxer interleaves them and applies backpressure. Wait for both to stop
    // (a failure in one aborts the other) before tearing anything down, then report the first failure.
    const settled = await Promise.allSettled([run(videoTask), audioTask ? run(audioTask) : Promise.resolve()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    o.onProgress?.(1, 'Finishing…');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    // If the user cancelled, a track may have failed with some other error while being torn down: report the cancel.
    if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    await Promise.all(feeds.map((f) => f?.close().catch(() => {})));
  }

  return { warning };
}

const EXPORT_PREFIX = 'stack-export-';
/** Export files older than this are leftovers (closed results, killed sessions); newer ones may be another tab's. */
const STALE_MS = 60 * 60 * 1000;

type OutputFile = Awaited<ReturnType<typeof openOutputFile>>;

/**
 * Where the MP4 is written. In the origin's private file system (OPFS) when the browser can write to it, so a long
 * 2× export streams to disk instead of being held in memory (and then copied again into a Blob), which could get
 * the tab killed on iPhone. Falls back to memory where OPFS writes aren't available.
 */
async function openOutputFile(): Promise<{
  target: Target;
  fastStart: false | 'in-memory';
  result(): Promise<Blob>;
  discard(): Promise<void>;
}> {
  try {
    // Safari before 26 has OPFS but no createWritable: check before creating a file we couldn't write.
    if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) {
      throw new Error('No OPFS writable streams');
    }
    const root = await navigator.storage.getDirectory();
    // Each result deletes its own file when it's closed. Sweep up only old leftovers (a session killed mid-export):
    // a recent file may belong to an export or result open in another tab.
    for await (const entry of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const made = parseInt(entry.slice(EXPORT_PREFIX.length), 10); // "<ms>-<random>.mp4"
      if (entry.startsWith(EXPORT_PREFIX) && !(Date.now() - made < STALE_MS)) await root.removeEntry(entry).catch(() => {});
    }
    const name = `${EXPORT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return {
      // Writes land at explicit byte positions, which the OPFS stream supports, so the MP4 index can go at the
      // end (fastStart: false) instead of buffering the whole file to put it first.
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
      fastStart: false,
      async result() {
        const file = await handle.getFile();
        return file.slice(0, file.size, 'video/mp4');
      },
      async discard() {
        await root.removeEntry(name).catch(() => {});
      },
    };
  } catch {
    const target = new BufferTarget();
    return {
      target,
      fastStart: 'in-memory',
      async result() {
        return new Blob([target.buffer!], { type: 'video/mp4' });
      },
      async discard() {},
    };
  }
}

/** AAC if the browser can encode it (loading the WASM encoder if needed), else Opus, else null. */
async function pickAudioCodec() {
  if (!(await canEncodeAudio('aac'))) {
    try {
      // Instagram wants AAC. If the browser can't encode it natively, lazy-load a WASM AAC encoder.
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
    } catch (e) {
      console.warn('Could not load the AAC encoder', e); // e.g. offline before it was ever cached
    }
  }
  return getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 });
}

/**
 * Write the clip's sound, looped to fill `duration`. Each pass covers exactly the picture's loop
 * (media.start … media.start + loopLength), measured in samples: buffers are placed by their timestamps,
 * gaps are filled with silence and overlaps trimmed, so sound can't drift from the looping picture.
 */
async function writeLoopedAudio(
  out: AudioBufferSource,
  sink: AudioBufferSink,
  media: Media,
  duration: number,
  checkAborted: () => void,
  onProgress: (p: number) => void,
) {
  // Take the format from the decoded audio, not the track metadata: they differ for HE-AAC (SBR, parametric
  // stereo), and silence must match the real buffers or the encoder rejects the change.
  const probe = sink.buffers(media.start, media.start + loopLength(media));
  const first = await probe.next();
  await probe.return(undefined);
  if (first.done) {
    onProgress(1); // no audio in the looped range
    return;
  }
  const rate = first.value.buffer.sampleRate;
  const channels = first.value.buffer.numberOfChannels;
  const loopLen = loopLength(media);
  const loopSamples = Math.round(loopLen * rate);
  const totalSamples = Math.round(duration * rate);
  let written = 0; // samples written to the output so far

  const writeSilence = async (n: number) => {
    while (n > 0) {
      const len = Math.min(n, rate); // ≤ 1 s per buffer
      await out.add(new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: rate }));
      written += len;
      n -= len;
    }
    onProgress(written / totalSamples);
  };

  for (let passStart = 0; passStart < totalSamples; passStart += loopSamples) {
    const passEnd = Math.min(passStart + loopSamples, totalSamples);
    for await (const { buffer, timestamp } of sink.buffers(media.start, media.start + loopLen)) {
      checkAborted();
      // Where this buffer belongs in the output, and which of its samples are still needed.
      let at = passStart + Math.round((timestamp - media.start) * rate);
      if (Math.abs(at - written) <= 2) at = written; // rounding noise at a join, not a real gap or overlap
      const from = Math.max(0, written - at); // skip what overlaps already-written audio (or precedes the start)
      if (at + from > written) await writeSilence(Math.min(at + from, passEnd) - written); // fill a gap
      const to = Math.min(buffer.length, passEnd - at); // stop at the end of this pass
      if (to > from) {
        await out.add(sliceAudio(buffer, from, to));
        written += to - from;
        onProgress(written / totalSamples);
      }
      if (written >= passEnd) break;
    }
    // The sound ran out before the picture's loop did: pad with silence so the next pass starts on time.
    if (written < passEnd) await writeSilence(passEnd - written);
  }
}

function sliceAudio(b: AudioBuffer, from: number, to: number): AudioBuffer {
  if (from === 0 && to === b.length) return b;
  const out = new AudioBuffer({ length: to - from, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    out.copyToChannel(b.getChannelData(ch).subarray(from, to), ch);
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
  // iPadOS Safari reports a Mac user agent; touch points tell it apart from a real Mac.
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  if (nav.canShare?.({ files: [file] }) && mobile) {
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
