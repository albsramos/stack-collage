import { BAYER } from './orb';

/** How the collage is drawn: as is, as a blue ordered dither (the orb's look), or as a grid of coloured dots. */
export type Look = 'original' | 'dither' | 'dots';

export const LOOKS: { id: Look; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'dither', label: 'Dither' },
  { id: 'dots', label: 'Dots' },
];

const INK = '#1f3dff';
const PAPER = { dither: '#ffffff', dots: '#0a0a0b' };

// One small scratch canvas, reused: each cell's colour is read from a downscaled copy of the source.
let scratch: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function sample(src: CanvasImageSource, cols: number, rows: number) {
  if (!scratch) {
    const c = document.createElement('canvas');
    scratch = { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
  }
  const { c, ctx } = scratch;
  if (c.width !== cols || c.height !== rows) {
    c.width = cols;
    c.height = rows;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows).data;
}

/**
 * Redraw `src` over the whole of `dst` (w×h px) as square dots `cell` px apart.
 * `reveal` (0–1) shows only the dots whose ordered-dither threshold is below it, so the picture assembles
 * itself in the orb's pattern as it rises.
 */
export function ditherTo(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  look: Exclude<Look, 'original'>,
  cell: number,
  reveal = 1,
) {
  const cols = Math.max(1, Math.round(w / cell));
  const rows = Math.max(1, Math.round(h / cell));
  const cw = w / cols;
  const ch = h / rows;
  const d = sample(src, cols, rows);
  dst.fillStyle = PAPER[look];
  dst.fillRect(0, 0, w, h);
  const dot = 0.82;
  const ox = (cw * (1 - dot)) / 2;
  const oy = (ch * (1 - dot)) / 2;
  if (look === 'dither') dst.fillStyle = INK;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const th = (BAYER[(j % 8) * 8 + (i % 8)] + 0.5) / 64;
      if (th > reveal) continue;
      const k = (j * cols + i) * 4;
      const r = d[k], g = d[k + 1], b = d[k + 2];
      if (look === 'dither') {
        // Darker areas get more ink. A slight curve keeps mid-tones from going solid.
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if ((1 - lum) ** 1.15 <= th) continue;
      } else {
        dst.fillStyle = `rgb(${r},${g},${b})`;
      }
      const x = Math.round(i * cw + ox);
      const y = Math.round(j * ch + oy);
      dst.fillRect(x, y, Math.round(i * cw + ox + cw * dot) - x, Math.round(j * ch + oy + ch * dot) - y);
    }
  }
}

/** Dot spacing for a frame `w` px wide: 120 dots across, whatever the export size. */
export const cellFor = (w: number) => w / 120;
