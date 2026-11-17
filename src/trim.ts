import type { Media } from './media';

/** The part of a video slot that's kept, in seconds from the clip's first frame (0 … media.duration). */
export interface Trim {
  in: number;
  out: number;
}

export const TRIM_MIN = 0.5; // shortest clip the trimmer allows, in seconds
export const TRIM_STEP = 0.1; // handles snap to this

/** The kept range of a clip: the whole thing unless it's trimmed. */
export function trimOf(m: Media, trim?: Trim): Trim {
  if (!trim) return { in: 0, out: m.duration };
  const out = Math.min(trim.out, m.duration);
  return { in: Math.max(0, Math.min(trim.in, out - TRIM_MIN)), out };
}

export const isTrimmed = (m: Media, trim?: Trim) => {
  const r = trimOf(m, trim);
  return r.in > 0.001 || r.out < m.duration - 0.001;
};

/** How long the clip plays, trimmed. */
export const clipLength = (m: Media, trim?: Trim) => {
  const r = trimOf(m, trim);
  return r.out - r.in;
};

/**
 * The clip as the exporter sees it: a trim just moves its start and shortens it. Everything that reads a video
 * (frames, the loop, the sound) already works from `start` and `duration`, so nothing else has to know about trims.
 */
export function trimmedMedia(m: Media, trim?: Trim): Media {
  if (m.kind !== 'video' || !trim) return m;
  const r = trimOf(m, trim);
  return { ...m, start: m.start + r.in, duration: r.out - r.in };
}
