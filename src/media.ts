import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export interface Media {
  id: string;
  kind: 'image' | 'video';
  file: File;
  url: string;
  w: number; // display width (after rotation)
  h: number;
  duration: number; // seconds, 0 for images
  hasAudio: boolean;
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
    return { id, kind: 'image', file, url, w: img.naturalWidth, h: img.naturalHeight, duration: 0, hasAudio: false, image: img };
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    if (!(await track.canDecode())) {
      throw new Error(`This browser can't decode “${file.name}” (${track.codec ?? 'unknown codec'}).`);
    }
    const duration = await input.computeDuration();
    const audio = await input.getPrimaryAudioTrack();
    const hasAudio = !!audio && (await audio.canDecode());
    return { id, kind: 'video', file, url, w: track.displayWidth, h: track.displayHeight, duration, hasAudio };
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
