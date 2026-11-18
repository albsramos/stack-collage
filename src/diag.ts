// What the last export did, step by step, so a failure on someone else's phone can be sent back as text
// ("Copy details" on the error) instead of a screenshot of one line.

const MAX = 80;
const lines: string[] = [];
let t0 = 0;

/** Start a new log for this export. */
export function diagStart() {
  lines.length = 0;
  t0 = performance.now();
}

export function note(msg: string) {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${msg}`);
  if (lines.length > MAX) lines.splice(1, 1); // keep the first line (the setup), drop the oldest after it
}

declare const __BUILD__: string;

export function diagReport(error: unknown) {
  const e = error as Error;
  const standalone = document.documentElement.dataset.standalone !== undefined;
  return [
    `Stack export report`,
    `Error: ${e?.message ?? String(error)}`,
    `Build: ${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}`,
    `Browser: ${navigator.userAgent}`,
    `Opened as: ${standalone ? 'Home Screen app' : 'browser tab'} · ${screen.width}×${screen.height} @${devicePixelRatio}x · ${navigator.hardwareConcurrency ?? '?'} cores`,
    `WebCodecs: VideoDecoder ${'VideoDecoder' in window ? 'yes' : 'no'}, VideoEncoder ${'VideoEncoder' in window ? 'yes' : 'no'}, AudioDecoder ${'AudioDecoder' in window ? 'yes' : 'no'}`,
    ``,
    ...lines,
  ].join('\n');
}
