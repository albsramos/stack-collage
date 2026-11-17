// Lazily loaded code (the exporter, mediabunny) lives in hashed files that each deploy replaces. The service worker
// keeps the running version's files until the app is closed, but if one still can't be loaded, the page is out of
// date: say so plainly and offer a reload, rather than Safari's "Importing a module script failed".

export const STALE_APP = 'Stack was updated and needs a reload to finish this. Sorry!';

export class StaleAppError extends Error {
  constructor(cause: unknown) {
    super(STALE_APP);
    this.name = 'StaleAppError';
    console.error(cause);
  }
}

export const isStale = (e: unknown) => e instanceof StaleAppError;

export function importFresh<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((e) => {
    throw new StaleAppError(e);
  });
}

/** Reload onto the newest version: let a waiting service worker take over first, so the reload isn't served the old one. */
export async function reloadToUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg?.waiting) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => location.reload(), 3000); // in case the takeover never comes
  } else {
    location.reload();
  }
}
