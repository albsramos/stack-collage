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
  canEncodeVideo,
  type WrappedCanvas,
} from 'mediabunny';
import { clamp, computeSlots, mediaRect, type Format, type LayoutOpts, type Rect, type Transform } from './layout';
import type { Media } from './media';
import { trimmedMedia, type Trim } from './trim';

export interface SlotState {
  media: Media | null;
  t: Transform;
  /** Video only: the part of the clip that's kept. Cleared when the clip is replaced. */
  trim?: Trim;
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
  // Apply trims up front: from here on a trimmed clip is just a shorter clip that starts later.
  o = { ...o, slots: o.slots.map((s) => (s.media ? { ...s, media: trimmedMedia(s.media, s.trim) } : s)) };
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

/** Frames for one slot, already cropped to the slot's visible area, from frame `from` onwards. */
interface FrameSource {
  next(): Promise<CanvasImageSource | null>;
  close(): Promise<void>;
}

interface FeedSpec {
  media: Media;
  crop: ReturnType<typeof visibleCrop>;
  width: number;
  height: number;
  total: number;
  /** Where in the clip output frame `f` comes from, looping. */
  timeAt(f: number): number;
}

/** A failing decoder is reopened this many times in a row before the slot falls back to a <video> element. */
const DECODER_RETRIES = 2;

async function openVideoFeed(media: Media, rect: Rect, s: SlotState, total: number, slot: number): Promise<VideoFeed> {
  // Decode only the visible part, at the slot's size but never above the source's own resolution. Decoding the
  // whole zoomed frame could ask for a canvas far beyond iOS's ~16.7 MP limit (5× zoom at 2× output), which fails.
  const crop = visibleCrop(rect, media, s.t);
  const k = Math.min(1, crop.width / rect.w);
  const loopLen = loopLength(media);
  const spec: FeedSpec = {
    media,
    crop,
    width: Math.max(2, Math.round(rect.w * k)),
    height: Math.max(2, Math.round(rect.h * k)),
    total,
    // Stay a hair inside the clip so the last frame is always found.
    timeAt: (f) => media.start + Math.min((f / FPS) % loopLen, Math.max(0, loopLen - 1 / (FPS * 4))),
  };

  // Safari's hardware decoder can fail partway through a clip ("Decoding task failed"), seen with several iPhone
  // 4K HEVC clips decoding at once. A fresh decoder picks up where the old one stopped, and a clip that keeps
  // failing is read through a <video> element instead — slower, but it plays whatever the preview plays.
  let source = await openDecoderSource(spec, 0);
  let usingElement = false;
  let failures = 0; // in a row
  let closed = false;
  let f = 0; // next output frame
  let last: SlotSource = null;
  const label = `video ${slot + 1} (“${media.file.name}”)`;
  return {
    async next() {
      for (;;) {
        try {
          const c = await source.next();
          f++;
          failures = 0;
          if (c) last = { src: c, cropped: true };
          return last;
        } catch (e) {
          if (closed || (e as DOMException).name === 'AbortError') throw e;
          console.warn(`Export: reading ${label} failed at frame ${f}`, e);
          await source.close().catch(() => {});
          if (!usingElement && failures < DECODER_RETRIES) {
            failures++;
            source = await openDecoderSource(spec, f);
          } else if (!usingElement) {
            usingElement = true;
            failures = 0;
            source = await openElementSource(spec, f).catch((e2) => {
              throw new Error(`Couldn't read ${label}: ${(e as Error).message || e}`, { cause: e2 });
            });
          } else {
            throw new Error(`Couldn't read ${label}: ${(e as Error).message || e}`);
          }
          if (closed) await source.close().catch(() => {});
        }
      }
    },
    async close() {
      closed = true;
      await source.close();
    },
  };
}

async function openDecoderSource(spec: FeedSpec, from: number): Promise<FrameSource> {
  const input = new Input({ source: new BlobSource(spec.media.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`No video track in “${spec.media.file.name}”.`);
    const sink = new CanvasSink(track, {
      crop: spec.crop,
      width: spec.width,
      height: spec.height,
      // 'cover', not 'fill': the crop already has the slot's shape, but if the decoder's frames don't match the
      // track's stated size (seen on iPhone), a hair is cropped off instead of the picture being stretched.
      fit: 'cover',
      poolSize: 3,
    });
    function* times() {
      for (let f = from; f < spec.total; f++) yield spec.timeAt(f);
    }
    const it = sink.canvasesAtTimestamps(times());
    return {
      async next() {
        const r = await it.next();
        const w = r.value as WrappedCanvas | null | undefined;
        return w ? (w.canvas as CanvasImageSource) : null;
      },
      async close() {
        await it.return?.(undefined).catch(() => {});
        input.dispose?.();
      },
    };
  } catch (e) {
    input.dispose?.();
    throw e;
  }
}

/** Resolve when `target` fires `ok`, reject on `error` or after `ms`. */
function once(target: HTMLMediaElement, ok: string, ms: number, what: string) {
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onErr);
      fn();
    };
    const onOk = () => done(resolve);
    const onErr = () => done(() => reject(new Error(target.error?.message || `The video couldn't be ${what}.`)));
    const timer = setTimeout(() => done(() => reject(new Error(`The video took too long to be ${what}.`))), ms);
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onErr);
  });
}

/**
 * Frames from a hidden <video> element, seeked to each frame's time. The fallback when WebCodecs can't decode a
 * clip: the browser's own player is a separate decoding path, the one the preview already uses successfully.
 */
async function openElementSource(spec: FeedSpec, from: number): Promise<FrameSource> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  // In the page but invisible: some browsers don't decode frames for a video that isn't in the document.
  v.setAttribute('aria-hidden', 'true');
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(v);
  const { c, ctx } = makeCanvas(spec.width, spec.height);
  const close = async () => {
    v.removeAttribute('src');
    v.load(); // frees the decoder now rather than at garbage collection
    v.remove();
  };
  try {
    const loaded = once(v, 'loadeddata', 15_000, 'opened');
    v.src = spec.media.url;
    v.load();
    // iOS may not fetch any frames until the video has played; a muted play is always allowed.
    v.play().then(() => v.pause(), () => {});
    await loaded;
    v.pause();
    let useFrameCallback = 'requestVideoFrameCallback' in v;
    let f = from;
    return {
      async next() {
        if (f >= spec.total) return null;
        const t = spec.timeAt(f++);
        if (Math.abs(v.currentTime - t) > 1 / (FPS * 8)) {
          const seeked = once(v, 'seeked', 15_000, 'read at this point');
          v.currentTime = t;
          await seeked;
          // 'seeked' can fire before the new frame is ready to draw; wait for it, but don't rely on it arriving.
          if (useFrameCallback) {
            const shown = await Promise.race([
              new Promise<boolean>((r) => v.requestVideoFrameCallback(() => r(true))),
              new Promise<boolean>((r) => setTimeout(() => r(false), 250)),
            ]);
            if (!shown) useFrameCallback = false;
          }
        }
        // The crop is in display pixels of the size mediabunny reported; scale it if the element's differs.
        const kx = (v.videoWidth || spec.media.w) / spec.media.w;
        const ky = (v.videoHeight || spec.media.h) / spec.media.h;
        const { left, top, width, height } = spec.crop;
        ctx.drawImage(v, left * kx, top * ky, width * kx, height * ky, 0, 0, spec.width, spec.height);
        return c;
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

interface VideoConfig {
  codec: VideoCodec;
  fullCodecString?: string;
  bitrate: number;
}

/**
 * Finds a codec + profile + bitrate the browser will actually accept at this size. Probing only the codec and size
 * isn't enough: iOS Safari passes `avc` at 2160×3840, then rejects the real config (Baseline profile, ~45 Mbps) once
 * encoding starts. So every candidate is probed exactly as it will be configured, best first.
 */
async function pickVideoConfig(width: number, height: number, k: number): Promise<VideoConfig | null> {
  // ~16 Mbps at 1080×1920 — well above what Instagram keeps, so their re-encode starts from a clean master.
  // At 2× this grows by k^1.5 (~45 Mbps), not k² (64 Mbps): the extra bits buy little once the encoder has 4× the
  // pixels to spend them on, and a 60 s 2× file stays ~340 MB instead of ~480 MB.
  const ideal = Math.round(16_000_000 * k ** 1.5);
  const bitrates = [...new Set([ideal, 30_000_000, 20_000_000, 12_000_000].filter((b) => b <= ideal))];
  const codecs: Omit<VideoConfig, 'bitrate'>[] = [
    { codec: 'avc' }, // mediabunny's pick (Baseline): what plays everywhere
    { codec: 'avc', fullCodecString: 'avc1.640033' }, // High @ 5.1: what hardware H.264 encoders prefer at 4K
    { codec: 'avc', fullCodecString: 'avc1.4d0033' }, // Main @ 5.1
    { codec: 'hevc' }, // iPhones encode 4K HEVC in hardware; Instagram and Photos accept it
  ];
  for (const bitrate of bitrates) {
    for (const c of codecs) {
      const ok = await canEncodeVideo(c.codec, { width, height, bitrate, frameRate: FPS, fullCodecString: c.fullCodecString }).catch(
        () => false,
      );
      if (ok) return { ...c, bitrate };
    }
  }
  return null;
}

async function exportVideo(o: ExportOpts): Promise<ExportResult> {
  const k = o.scale;
  const W = o.format.w * k;
  const H = o.format.h * k;
  const longest = Math.max(...o.slots.map((s) => (s.media?.kind === 'video' ? s.media.duration : 0)));
  const duration = Math.min(longest, o.maxDuration);
  const total = Math.max(1, Math.round(duration * FPS));

  const video = await pickVideoConfig(W, H, k);
  if (!video) throw new Error(`This browser can't encode ${W}×${H} video. Try the Standard size.`);

  const sink = await openOutputFile();
  try {
    const { warning } = await encodeVideo(o, sink, video, duration, total);
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
  video: VideoConfig,
  duration: number,
  total: number,
): Promise<{ warning?: string }> {
  const k = o.scale;
  const rects = computeSlots(o.format, o.layout);
  const { c, ctx } = makeCanvas(o.format.w * k, o.format.h * k);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  const videoSource = new CanvasSource(c, {
    codec: video.codec,
    fullCodecString: video.fullCodecString,
    bitrate: video.bitrate,
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
  // Watchdog: iOS can accept an encoder config and then never produce a frame, which left export stuck at 0%.
  // Any progress counts as a heartbeat; a long silence ends the export with an explanation.
  let lastBeat = performance.now();
  const report = () => {
    lastBeat = performance.now();
    o.onProgress?.(Math.min(videoDone, audioDone));
  };

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
  let stalled = false;
  let watch = 0;
  const stall = new Promise<never>((_, reject) => {
    watch = window.setInterval(() => {
      if (performance.now() - lastBeat < STALL_MS || stop.signal.aborted) return;
      stalled = true;
      stop.abort();
      reject(
        new Error(
          k > 1
            ? "This phone stopped encoding the High quality video. Try the Standard size."
            : 'Encoding stopped responding. Close other apps and try again.',
        ),
      );
    }, 1000);
  });
  const work = async () => {
    await output.start();
    // Open the feeds one by one, so if one fails the ones already opened are still closed below.
    for (let i = 0; i < o.slots.length; i++) {
      const s = o.slots[i];
      if (s.media?.kind === 'video') feeds[i] = await openVideoFeed(s.media, scaleRect(rects[i], k), s, total, i);
    }
    // Feed both tracks concurrently — the muxer interleaves them and applies backpressure. Wait for both to stop
    // (a failure in one aborts the other) before tearing anything down, then report the first failure.
    const settled = await Promise.allSettled([run(videoTask), audioTask ? run(audioTask) : Promise.resolve()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    o.onProgress?.(1, 'Finishing…');
    lastBeat = performance.now();
    await output.finalize();
  };
  try {
    await Promise.race([work(), stall]);
  } catch (e) {
    // A stalled encoder may never answer: don't wait on it to cancel.
    const cancel = output.cancel().catch(() => {});
    if (!stalled) await cancel;
    // If the user cancelled, a track may have failed with some other error while being torn down: report the cancel.
    if (o.signal?.aborted && !stalled) throw new DOMException('Export cancelled', 'AbortError');
    throw e;
  } finally {
    window.clearInterval(watch);
    o.signal?.removeEventListener('abort', onAbort);
    const closing = Promise.all(feeds.map((f) => f?.close().catch(() => {})));
    if (!stalled) await closing;
  }

  return { warning };
}

/** No progress for this long means the encoder or a decoder has hung. Opening 4K clips can take a few seconds. */
const STALL_MS = 20_000;

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
