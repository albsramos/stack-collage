// Regenerates public/icons/* from the orb drawing code: `npm run icons`.
// Uses the pre-installed Playwright Chromium to rasterise the SVG into the PNG sizes.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { orbDots } from '../src/orb.ts';

const BLUE = '#1f3dff';
const BG = '#ffffff';

/** A square icon: the orb (resting frame) on a white tile, `inset` = fraction of padding on each side. */
function iconSvg(inset, grid = 24) {
  const S = 120;
  const area = S * (1 - inset * 2);
  const cell = area / grid;
  const dot = cell * 0.8;
  const off = S * inset + (cell - dot) / 2;
  const offY = off + area * 0.05; // the sphere sits at 45% of its grid: centre it in the tile
  const rects = orbDots(grid, { t: 0, spin: 0, fill: 0 }, 0.3)
    .map(({ i, j }) => `<rect x="${(off + i * cell).toFixed(2)}" y="${(offY + j * cell).toFixed(2)}" width="${dot.toFixed(2)}" height="${dot.toFixed(2)}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${BG}"/><g fill="${BLUE}">${rects}</g></svg>`;
}

const regular = iconSvg(0.06);
const maskable = iconSvg(0.16); // the maskable safe zone is the centre 80%
writeFileSync('public/icons/icon.svg', regular + '\n');

// require(), not import: it finds a globally installed Playwright via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const shoot = async (svg, size, file) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: `public/icons/${file}` });
};
await shoot(regular, 192, 'icon-192.png');
await shoot(regular, 512, 'icon-512.png');
await shoot(regular, 180, 'apple-touch-icon.png');
await shoot(maskable, 512, 'icon-512-maskable.png');
await browser.close();
console.log('icons written');
