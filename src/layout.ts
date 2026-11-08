// Geometry shared by the on-screen preview and the exporter, so what you see is exactly what you export.

export type FormatId = 'story' | 'post';
export type RatioId = 'fill' | '16:9' | '3:2' | '4:3' | '1:1' | '4:5';
export type Count = 2 | 3;

export interface Format {
  label: string;
  sub: string;
  w: number;
  h: number;
}

export const FORMATS: Record<FormatId, Format> = {
  story: { label: '9:16', sub: '9:16', w: 1080, h: 1920 },
  post: { label: '3:4', sub: '3:4', w: 1080, h: 1440 },
};

export const RATIOS: { id: RatioId; label: string; value: number | null }[] = [
  { id: 'fill', label: 'Fill', value: null },
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '3:2', label: '3:2', value: 3 / 2 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:5', label: '4:5', value: 4 / 5 },
];

export interface LayoutOpts {
  count: Count;
  ratio: RatioId;
  gap: number; // in base px (canvas is 1080 wide)
  margin: number; // outer padding, base px
  radius: number; // corner radius, base px
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function defaultLayout(count: Count, format: FormatId): LayoutOpts {
  // Slots always fill the whole frame edge to edge — no gaps, no background showing.
  void format;
  return { count, ratio: 'fill', gap: 0, margin: 0, radius: 0 };
}

/** Slot rectangles in base units (format.w × format.h). */
export function computeSlots(format: Format, o: LayoutOpts): Rect[] {
  const { w: W, h: H } = format;
  const n = o.count;
  const m = Math.min(o.margin, W / 3, H / 3);
  const availW = W - 2 * m;
  const availH = H - 2 * m;
  const gapTotal = o.gap * (n - 1);
  const r = RATIOS.find((x) => x.id === o.ratio)?.value ?? null;

  let slotW = availW;
  let slotH: number;
  if (r === null) {
    slotH = (availH - gapTotal) / n;
  } else {
    slotH = slotW / r;
    if (slotH * n + gapTotal > availH) {
      slotH = (availH - gapTotal) / n;
      slotW = slotH * r;
    }
  }
  slotH = Math.max(1, slotH);
  const totalH = slotH * n + gapTotal;
  const x0 = (W - slotW) / 2;
  const y0 = (H - totalH) / 2;
  return Array.from({ length: n }, (_, i) => ({
    x: x0,
    y: y0 + i * (slotH + o.gap),
    w: slotW,
    h: slotH,
  }));
}

export interface Transform {
  zoom: number; // ≥ 1, relative to "cover"
  x: number; // -1..1, pan as fraction of available overflow
  y: number;
}

export const IDENTITY: Transform = { zoom: 1, x: 0, y: 0 };

/** Where to draw media of size mw×mh inside a slot, given the user's pan/zoom. */
export function mediaRect(slot: Rect, mw: number, mh: number, t: Transform): Rect {
  const s = Math.max(slot.w / mw, slot.h / mh) * t.zoom;
  const dw = mw * s;
  const dh = mh * s;
  const maxX = (dw - slot.w) / 2;
  const maxY = (dh - slot.h) / 2;
  return {
    x: slot.x + (slot.w - dw) / 2 + t.x * maxX,
    y: slot.y + (slot.h - dh) / 2 + t.y * maxY,
    w: dw,
    h: dh,
  };
}

/** Max pan overflow (base px) for a slot — used to convert drag distance into normalized pan. */
export function overflow(slot: Rect, mw: number, mh: number, zoom: number) {
  const s = Math.max(slot.w / mw, slot.h / mh) * zoom;
  return { x: (mw * s - slot.w) / 2, y: (mh * s - slot.h) / 2 };
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
