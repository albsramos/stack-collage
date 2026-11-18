import { importFresh } from './stale';

export interface Media {
  id: string;
  kind: 'image' | 'video';
  file: File;
  url: string;
  w: number; // display width (after rotation)
  h: number;
  /** Video only: timestamp of the first video frame. Often 0, but trimmed or edited clips can start later. */
  start: number;
  duration: number; // seconds of video (from the first to the last frame), 0 for images
  hasAudio: boolean;
  /** The clip has a sound track this browser can't decode (e.g. Safari before 26 has no WebCodecs AudioDecoder). */
  audioUnsupported: boolean;
  image?: HTMLImageElement;
}

let counter = 0;

export async function loadMedia(file: File): Promise<Media> {
  const url = URL.createObjectURL(file);
  const id = `m${++counter}`;
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(file.name);

  if (!isVideo) {
    try {
      const { img, src } = await openImage(file, url);
      if (src !== url) URL.revokeObjectURL(url);
      // naturalWidth/Height already respect EXIF orientation in modern browsers.
      return {
        id, kind: 'image', file, url: src, w: img.naturalWidth, h: img.naturalHeight,
        start: 0, duration: 0, hasAudio: false, audioUnsupported: false, image: img,
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      const why = e instanceof Error && e.message ? ` (${e.name}: ${e.message})` : '';
      throw new Error(`Couldn't open “${file.name}”${why}. Try a JPEG or PNG.`);
    }
  }

  // Only videos need mediabunny: load it on the first one rather than with the app.
  const { ALL_FORMATS, BlobSource, Input } = await importFresh(() => import('mediabunny')).catch((e) => {
    URL.revokeObjectURL(url);
    throw e;
  });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    if (!(await track.canDecode())) {
      throw new Error(`This browser can't decode “${file.name}” (${track.codec ?? 'unknown codec'}).`);
    }
    // Time the loop on the video track itself: the container's duration also counts a longer audio track,
    // and measures from 0 even when the first frame comes later.
    const start = await track.getFirstTimestamp();
    const duration = Math.max(0, (await track.computeDuration()) - start);
    const audio = await input.getPrimaryAudioTrack();
    const hasAudio = !!audio && (await audio.canDecode());
    return {
      id, kind: 'video', file, url, w: track.displayWidth, h: track.displayHeight,
      start, duration, hasAudio, audioUnsupported: !!audio && !hasAudio,
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    input.dispose?.();
  }
}

/** Largest side a photo is redrawn at when the browser can't take the original (4K output needs 2160 across). */
const MAX_SIDE = 4096;

function loaded(img: HTMLImageElement) {
  return new Promise<void>((resolve, reject) => {
    if (img.complete) return img.naturalWidth ? resolve() : reject(new Error('The image failed to load.'));
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The image failed to load.'));
  });
}

/**
 * Open a photo, trying gentler ways when the first fails. WebKit's img.decode() can reject a photo it could still
 * show (seen with a large iPhone photo while 4K clips were loaded), so fall back to the plain load event, and then
 * to redrawing it smaller from the file itself.
 */
async function openImage(file: File, url: string): Promise<{ img: HTMLImageElement; src: string }> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  let first: unknown;
  try {
    await img.decode();
    return { img, src: url };
  } catch (e) {
    first = e;
    console.warn(`img.decode() failed for “${file.name}”`, e);
  }
  try {
    await loaded(img);
    return { img, src: url };
  } catch (e) {
    console.warn(`Loading “${file.name}” failed`, e);
  }
  try {
    const bitmap = await createImageBitmap(file); // applies EXIF orientation
    const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('Could not re-encode the photo.'))), 'image/jpeg', 0.92),
    );
    const src = URL.createObjectURL(blob);
    const small = new Image();
    small.src = src;
    try {
      await loaded(small);
    } catch (e) {
      URL.revokeObjectURL(src);
      throw e;
    }
    return { img: small, src };
  } catch (e) {
    console.warn(`Redrawing “${file.name}” failed`, e);
    throw first;
  }
}

export function releaseMedia(m: Media | null | undefined) {
  if (m) URL.revokeObjectURL(m.url);
}
