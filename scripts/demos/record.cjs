// Records the README demos: node record.cjs <url> <mediaDir> <outDir>
// Each scene is captured with Chrome's screencast (a frame on every repaint, with its timestamp).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const [url, media, out] = process.argv.slice(2);
const W = 390, H = 770; // the app's part of a 390×844 screen: the status bar and home indicator are drawn around it

// A touch ring that follows the (mouse-driven) pointer while it's pressed, like iOS screen recordings with touches.
const TOUCH = `
addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:2147483647;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
    'background:rgba(120,120,128,.28);box-shadow:0 0 0 1.5px rgba(255,255,255,.8),0 2px 8px rgba(0,0,0,.18);pointer-events:none;' +
    'opacity:0;transform:scale(.6);transition:opacity .18s,transform .18s;left:0;top:0';
  document.documentElement.appendChild(d);
  const at = (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; };
  addEventListener('pointerdown', (e) => { at(e); d.style.opacity = 1; d.style.transform = 'scale(1)'; }, true);
  addEventListener('pointermove', at, true);
  const up = () => { d.style.opacity = 0; d.style.transform = 'scale(1.3)'; };
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
});`;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light' });
  await ctx.addInitScript(TOUCH);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  const cdp = await ctx.newCDPSession(p);
  let frames = null;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    if (frames) frames.push({ t: metadata.timestamp, data });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const record = async (name, fn) => {
    frames = [];
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
    const t0 = Date.now() / 1000;
    await fn();
    const t1 = Date.now() / 1000;
    await cdp.send('Page.stopScreencast');
    const dir = path.join(out, name);
    fs.rmSync(dir, { recursive: true, force: true }); // dir is always out/<scene name>
    fs.mkdirSync(dir, { recursive: true });
    const list = frames.map((f, i) => {
      const file = `${String(i).padStart(4, '0')}.png`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
      return { file, t: f.t - t0 };
    });
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ duration: t1 - t0, frames: list }));
    console.log(name, list.length, 'frames', (t1 - t0).toFixed(1) + 's');
    frames = null;
  };
  const wait = (ms) => p.waitForTimeout(ms);
  const center = async (loc) => {
    const r = await loc.boundingBox();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const tap = async (loc, hold = 90) => {
    const c = await center(loc);
    await p.mouse.move(c.x, c.y);
    await p.mouse.down();
    await wait(hold);
    await p.mouse.up();
  };
  const drag = async (from, to, ms) => {
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await wait(120);
    const steps = Math.round(ms / 25);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out, like a finger
      await p.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      await wait(25);
    }
    await wait(120);
    await p.mouse.up();
  };
  const pick = async (slot, file) => {
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), tap(p.locator(`[data-slot="${slot}"]`))]);
    await fc.setFiles(path.join(media, file));
  };

  // ---------- 1. start ----------
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await record('start', async () => {
    await p.reload();
    await wait(2600);
    await tap(p.getByText('3 cards'));
    await wait(1100);
    await tap(p.getByText('9:16').first());
    await wait(1300);
    await tap(p.getByRole('button', { name: 'Start' }));
    await wait(1200);
  });

  // ---------- 2. edit: fill the slots, then trim the clip ----------
  await record('edit', async () => {
    await wait(500);
    await pick(0, 'mountains.png');
    await wait(900);
    await pick(1, 'sunset.webm');
    await wait(1100);
    await pick(2, 'citrus.png');
    await wait(1300);
    await tap(p.locator('[data-slot="1"]'));
    await wait(900);
    await tap(p.getByRole('button', { name: /^Trim clip in slot/ }));
    await wait(1400);
    const strip = await p.locator('.trim-strip').boundingBox();
    const X = (t) => strip.x + 14 + ((strip.width - 28) * t) / 10;
    const y = strip.y + strip.height / 2;
    await drag({ x: X(0) - 7, y }, { x: X(2.5) - 7, y }, 900);
    await wait(500);
    await drag({ x: X(10) + 7, y }, { x: X(7.5) + 7, y }, 900);
    await wait(2800);
    await tap(p.getByRole('button', { name: 'Done' }));
    await wait(900);
    await tap(p.locator('.stage-wrap'), 60); // tap outside the frame to deselect
    await wait(1500);
  });

  // ---------- 3. export ----------
  await record('export', async () => {
    await wait(400);
    await tap(p.getByRole('button', { name: 'Export' }));
    await wait(1000);
    await tap(p.locator('.size-option').first());
    await p.mouse.move(2, 2); // a resting pointer over the result would keep its video controls showing
    await p.waitForSelector('video[controls]', { timeout: 180000 });
    await wait(2600);
  });

  await b.close();
})();
