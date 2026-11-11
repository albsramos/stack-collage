
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
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(`Couldn't open “${file.name}”. Try a JPEG or PNG.`);
    }
    // naturalWidth/Height already respect EXIF orientation in modern browsers.
    return {
      id, kind: 'image', file, url, w: img.naturalWidth, h: img.naturalHeight,
      start: 0, duration: 0, hasAudio: false, audioUnsupported: false, image: img,
    };
  }

  // Only videos need mediabunny: load it on the first one rather than with the app.
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny').catch((e) => {
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

export function releaseMedia(m: Media | null | undefined) {
  if (m) URL.revokeObjectURL(m.url);
}
