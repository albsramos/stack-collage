// Debug view: every vehicle mesh at eight headings.
import { MESH } from '../src/engine/vehicles';
import { drawMesh, type R } from '../src/engine/draw';
import { lightPalette } from '../src/engine/palette';

export function gallery(root: HTMLElement) {
  const pal = lightPalette();
  const c = document.createElement('canvas');
  const W = 1600, H = 900, dpr = 2;
  c.width = W * dpr;
  c.height = H * dpr;
  c.style.width = W + 'px';
  c.style.height = H + 'px';
  root.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, c.width, c.height);
  const scale = 22 * dpr;
  const r: R = { ctx, t: 0, hair: 0.7 / scale, scale, night: false };
  const kinds = ['car', 'suv', 'pickup', 'pod', 'van', 'tractor', 'forklift', 'crate'] as const;
  kinds.forEach((k, row) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const X = 90 + i * 190, Y = 70 + row * 105;
      ctx.setTransform(scale, 0, 0, scale, X * dpr, Y * dpr);
      const mats = [k === 'pod' || k === 'van' ? pal.gold : pal.paints[k === 'car' ? 0 : 3], pal.carGlass, pal.tyre, pal.headlight, pal.taillight, pal.white, pal.robot, pal.robotHead];
      drawMesh(r, MESH[k], 0, 0, 0, Math.cos(a), Math.sin(a), mats);
    }
  });
  // trailers
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    ctx.setTransform(scale * 0.6, 0, 0, scale * 0.6, (200 + i * 380) * dpr, 870 * dpr);
    drawMesh(r, MESH.trailer, 0, 0, 0, Math.cos(a), Math.sin(a), [pal.white, pal.carGlass, pal.tyre, pal.headlight, pal.taillight, pal.white]);
  }
}
