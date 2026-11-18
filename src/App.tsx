import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FORMATS,
  IDENTITY,
  clamp,
  computeSlots,
  defaultLayout,
  mediaRect,
  overflow,
  type Count,
  type FormatId,
  type LayoutOpts,
  type Rect,
  type Transform,
} from './layout';
import { STALE_APP, importFresh, isStale, reloadToUpdate } from './stale';
import { loadMedia, releaseMedia, type Media } from './media';
import { Trimmer } from './Trimmer';
import { diagReport, diagStart } from './diag';
import { clipLength, isTrimmed, trimOf, type Trim } from './trim';
import type { ExportResult, SlotState } from './exporter';
import { Orb } from './Orb';
import { DitherField, LookPreview, snapshot } from './Previews';

// The exporter pulls in mediabunny (~200 KB gzipped). It's kept out of the startup bundle but loaded right after
// startup (see warmExporter), so Export never waits on it. One shared promise; a failure resets it for a retry.
let exporter: Promise<typeof import('./exporter')> | null = null;
const loadExporter = () =>
  (exporter ??= importFresh(() => import('./exporter')).catch((e) => {
    exporter = null;
    throw e;
  }));
const warmExporter = () => {
  const id = setTimeout(() => void loadExporter().catch(() => {}), 300);
  return () => clearTimeout(id);
};
const hasVideo = (slots: SlotState[]) => slots.some((s) => s.media?.kind === 'video');

type Step = 'start' | 'editor';

const MAX_DURATION = 60;

const emptySlots = (): SlotState[] => [0, 1, 2].map(() => ({ media: null, t: { ...IDENTITY } }));

/** Put the export report on the clipboard, or hand it to the share sheet where the clipboard isn't allowed. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await navigator.share({ text });
      return true;
    } catch {
      return false;
    }
  }
}

interface Toast {
  msg: string;
  /** Errors stay until dismissed; everything else hides itself. */
  error?: boolean;
  action?: { label: string; run: () => void };
}

const UNDO_MS = 6000;

// React StrictMode runs effects twice in development: make sure the history fix-up below runs once.
let historyNormalized = false;

// The last template picked, so a returning user only has to tap Start.
const TEMPLATE_KEY = 'stack.template';
function loadTemplate(): { count: Count | null; format: FormatId | null } {
  try {
    const v = JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? 'null') as { count?: unknown; format?: unknown } | null;
    return {
      count: v?.count === 2 || v?.count === 3 ? v.count : null,
      // hasOwn, not `in`: "constructor" or "toString" would pass an `in` check.
      format: typeof v?.format === 'string' && Object.hasOwn(FORMATS, v.format) ? (v.format as FormatId) : null,
    };
  } catch {
    return { count: null, format: null }; // storage blocked (private mode) or corrupted
  }
}
function saveTemplate(count: Count, format: FormatId) {
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ count, format }));
  } catch {
    // Not remembering is fine.
  }
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function App() {
  const [step, setStep] = useState<Step>('start');
  const [count, setCount] = useState<Count>(3);
  const [formatId, setFormatId] = useState<FormatId>('story');
  const [saved] = useState(loadTemplate);
  const [pickCount, setPickCount] = useState<Count | null>(saved.count);
  const [pickFormat, setPickFormat] = useState<FormatId | null>(saved.format);
  // Preview playback. Clips loop muted by default (not at all under reduced motion); "with sound" plays the
  // chosen Sound clip out loud, restarted together, so you can hear the export before making it.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [previewSound, setPreviewSound] = useState(false);
  const [hasSelected, setHasSelected] = useState(false);
  const [layout, setLayout] = useState<LayoutOpts>(defaultLayout(3, 'story'));
  const bg = '#000000'; // never visible: slots always fill the frame
  const [slots, setSlots] = useState<SlotState[]>(emptySlots);
  const [scale, setScale] = useState<1 | 2>(1);
  // Which clip's sound to use: a media id (so the choice follows the clip when slots are reordered), 'auto', or off.
  const [audioFrom, setAudioFrom] = useState<string | 'auto' | null>('auto');
  const [selected, setSelected] = useState<number | null>(null);
  // The clip whose trimmer is open (by id, so it stays open when the clip moves), and the time shown mid-drag.
  const [trimId, setTrimId] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  // A still of the collage, taken when Export opens: the export sheet shows it, and the busy
  // screen assembles it dot by dot while the file renders.
  const [snap, setSnap] = useState<HTMLCanvasElement | null>(null);
  const exportStart = useRef(0);
  // Start screen: the orb's light follows the finger; picking an option makes it react.
  const orbAim = useRef<number | null>(null);
  const orbBox = useRef<HTMLDivElement>(null);
  const [orbKick, setOrbKick] = useState(0);
  const aimAt = (e: React.PointerEvent) => {
    const r = orbBox.current?.getBoundingClientRect();
    if (!r) return;
    orbAim.current = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  const [justDone, setJustDone] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const installed = useMemo(() => document.documentElement.dataset.standalone !== undefined, []);
  // Chrome and Edge offer their own install prompt: keep it, so the guide can offer a one-tap Install.
  const [installPrompt, setInstallPrompt] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);
  useEffect(warmExporter, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as Event & { prompt: () => Promise<void> });
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setInstallOpen(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const [exportedOnce, setExportedOnce] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState<{ progress: number; label: string } | null>(null);
  const [result, setResult] = useState<(ExportResult & { url: string }) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // After an action removes the focused control (Remove, Done, moving to the end), put focus back on the slot
  // instead of letting it fall to <body>.
  const focusSlot = useRef<number | null>(null);
  useEffect(() => {
    if (focusSlot.current === null) return;
    document.querySelector<HTMLElement>(`[data-slot="${focusSlot.current}"]`)?.focus();
    focusSlot.current = null;
  });

  // The strip iOS reserves below a Home Screen app shows the page background: match whatever sits at the bottom.
  // (CSS picks the colour from data-step, so it follows the light/dark theme.)
  useEffect(() => {
    document.documentElement.dataset.step = step;
  }, [step]);

  const format = FORMATS[formatId];
  const active = slots.slice(0, count);
  const anyVideo = hasVideo(active);
  const filled = active.every((s) => s.media);

  const showToast = useCallback((t: Toast | string) => setToast(typeof t === 'string' ? { msg: t } : t), []);
  const showError = useCallback((msg: string) => showToast({ msg, error: true }), [showToast]);
  const showStale = useCallback(
    () => showToast({ msg: STALE_APP, error: true, action: { label: 'Reload', run: () => void reloadToUpdate() } }),
    [showToast],
  );

  // Toasts hide themselves (errors excepted), but not while the pointer or keyboard focus is on them: someone
  // tabbing or swiping to Undo must be able to reach it.
  const [toastHeld, setToastHeld] = useState(false);
  useEffect(() => {
    if (!toast || toast.error || toastHeld) return;
    const id = window.setTimeout(() => setToast(null), toast.action ? UNDO_MS : 4000);
    return () => window.clearTimeout(id);
  }, [toast, toastHeld]);
  useEffect(() => setToastHeld(false), [toast]); // a new or cleared toast starts unheld
  // Ctrl/Cmd+Z runs the toast's action (Undo) while it's showing.
  useEffect(() => {
    const action = toast?.action;
    if (!action) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        action.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast]);

  // ---------- browser history: the system back gesture returns to the start screen instead of leaving the app ----------
  // While exporting or showing the result, Back must not leave the editor: the result would be lost (or shown
  // again later over the wrong template).
  const holdEditorRef = useRef(false);
  holdEditorRef.current = !!busy || !!result;
  const enteredRef = useRef(false); // has Start been pressed in this page load?
  useEffect(() => {
    // After a reload in the editor, the current entry still says "editor" but the app opens on the start screen:
    // step back onto the start entry, so the first back gesture isn't a no-op.
    if (!historyNormalized && (history.state as { stack?: string } | null)?.stack === 'editor') history.back();
    historyNormalized = true;
    const onPop = (e: PopStateEvent) => {
      if ((e.state as { stack?: string } | null)?.stack === 'editor') {
        // Forward into the editor: fine if it was opened in this page load (the slots are still there). An entry
        // left over from before a reload would open an empty editor on a template nobody picked: bounce back.
        if (enteredRef.current) setStep('editor');
        else history.back();
        return;
      }
      if (holdEditorRef.current) {
        history.pushState({ stack: 'editor' }, ''); // restore the entry we just left
        return;
      }
      setSelected(null);
      setStep('start');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Desktop browsers ask before a reload or closing the tab throws away loaded media. (iOS Safari ignores
  // beforeunload, so on iPhone this does nothing; the history entry above covers the back gesture there.)
  const hasMedia = slots.some((s) => s.media);
  useEffect(() => {
    if (!hasMedia) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasMedia]);

  // ---------- file picking ----------
  const fileInput = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<number | 'fill'>('fill');

  const openPicker = (target: number | 'fill') => {
    pickTarget.current = target;
    const el = fileInput.current!;
    el.multiple = target === 'fill';
    el.value = '';
    el.click();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const target = pickTarget.current;
    const indices =
      target === 'fill' ? active.map((s, i) => (s.media ? -1 : i)).filter((i) => i >= 0) : [target];
    const list = Array.from(files).slice(0, indices.length);
    // Finish any pending undo first: an Undo landing mid-load would race the slots being filled.
    settleUndo();
    setToast(null);
    setBusy({ progress: -1, label: 'Opening…' });
    const errors: string[] = [];
    let stale = false;
    for (let j = 0; j < list.length; j++) {
      try {
        const m = await loadMedia(list[j]);
        const idx = indices[j];
        // What's being replaced, from the latest render (outside the updater: StrictMode runs updaters twice).
        releaseMedia(slotsRef.current[idx].media);
        setSlots((prev) => prev.map((s, k) => (k === idx ? { media: m, t: { ...IDENTITY } } : s)));
      } catch (e) {
        if (isStale(e)) stale = true;
        else errors.push((e as Error).message);
      }
    }
    setBusy(null);
    if (stale) showStale();
    else if (errors.length) showError(errors.join(' '));
    else if (files.length > list.length) {
      showToast(`Added ${list.length} of ${files.length}: only ${list.length} slot${list.length === 1 ? ' was' : 's were'} empty.`);
    }
  };

  // ---------- slot ops ----------
  const setT = (i: number, t: Transform) =>
    setSlots((prev) => prev.map((s, k) => (k === i ? { ...s, t } : s)));
  const setTrim = (i: number, trim: Trim | undefined) =>
    setSlots((prev) => prev.map((s, k) => (k === i ? { ...s, trim } : s)));
  const openTrim = (i: number) => {
    const id = slots[i]?.media?.id;
    if (!id) return;
    setSelected(i);
    setHasSelected(true);
    setTrimId(id);
  };
  // Selecting another clip (or none) closes the trimmer.
  const selectedId = selected !== null ? slots[selected]?.media?.id : undefined;
  useEffect(() => {
    if (trimId && selectedId !== trimId) setTrimId(null);
  }, [selectedId, trimId]);
  useEffect(() => setScrub(null), [trimId]);

  // A removed clip is kept while its "Removed · Undo" toast shows; its memory is released once the toast goes.
  const undoRef = useRef<{ index: number; slot: SlotState } | null>(null);
  // The Undo button can be pressed after later renders: read the latest slots, not the ones it closed over.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const countRef = useRef(count);
  countRef.current = count;
  const settleUndo = () => {
    const u = undoRef.current;
    if (!u) return;
    releaseMedia(u.slot.media);
    undoRef.current = null;
  };
  useEffect(() => settleUndo, []); // release on unmount
  // The Undo toast expired, was dismissed or replaced: the removal is final.
  useEffect(() => {
    if (!toast?.action) settleUndo();
  }, [toast]);

  const removeSlot = (i: number) => {
    settleUndo(); // only the latest removal can be undone
    const removed = slots[i];
    setSlots((prev) => prev.map((s, k) => (k === i ? { media: null, t: { ...IDENTITY } } : s)));
    setSelected(null);
    focusSlot.current = i;
    undoRef.current = { index: i, slot: removed };
    showToast({ msg: 'Removed', action: { label: 'Undo', run: undoRemove } });
  };

  const undoRemove = () => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null;
    setToast(null);
    // Put it back where it was, or in the first visible empty slot if that one has been filled (or hidden, by
    // switching to a 2-card template) since.
    const now = slotsRef.current;
    const n = countRef.current;
    const at = u.index < n && !now[u.index].media ? u.index : now.findIndex((s, k) => k < n && !s.media);
    if (at < 0) {
      releaseMedia(u.slot.media);
      showToast('No empty slot to put it back in.');
      return;
    }
    setSlots((prev) => prev.map((s, k) => (k === at ? u.slot : s)));
  };

  const moveSlot = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= count) return;
    setSlots((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setSelected(j);
    focusSlot.current = j;
  };

  const deselect = () => {
    if (selected !== null) focusSlot.current = selected;
    setSelected(null);
  };

  /** Move the media inside the selected slot without dragging (buttons and arrow keys). */
  const nudge = (i: number, dx: number, dy: number, dz = 1) =>
    // Functional update: held-down arrow keys fire faster than React re-renders.
    setSlots((prev) =>
      prev.map((s, k) =>
        k === i
          ? { ...s, t: { zoom: clamp(s.t.zoom * dz, 1, 5), x: clamp(s.t.x + dx, -1, 1), y: clamp(s.t.y + dy, -1, 1) } }
          : s,
      ),
    );

  // ---------- flow ----------
  const start = () => {
    if (!pickCount || !pickFormat) return;
    setCount(pickCount);
    setFormatId(pickFormat);
    setLayout(defaultLayout(pickCount, pickFormat));
    setStep('editor');
    enteredRef.current = true;
    // Normally push; if we're already on an "editor" entry (back then forward) reuse it so Back stays one step.
    if ((history.state as { stack?: string } | null)?.stack === 'editor') history.replaceState({ stack: 'editor' }, '');
    else history.pushState({ stack: 'editor' }, '');
    saveTemplate(pickCount, pickFormat);
  };

  const back = () => {
    setSelected(null);
    // Leave through history so the entry pushed by start() doesn't linger (and the popstate handler switches screens).
    if ((history.state as { stack?: string } | null)?.stack === 'editor') history.back();
    else setStep('start');
  };

  const resolvedAudio = useMemo(() => {
    if (audioFrom === null) return null;
    const withSound = (s: SlotState) => s.media?.kind === 'video' && s.media.hasAudio;
    const chosen = active.findIndex((s) => withSound(s) && s.media!.id === audioFrom);
    if (chosen >= 0) return chosen;
    // 'auto', or the chosen clip was removed: use the first clip that has sound.
    const i = active.findIndex(withSound);
    return i >= 0 ? i : null;
  }, [audioFrom, active]);

  // Play/unmute right here in the click handler, not later in an effect: iOS only lets media start with sound
  // inside the user's gesture. The state then keeps React's view of it in step.
  const previewVideos = () => [...document.querySelectorAll<HTMLVideoElement>('.slot video')];
  const togglePlaying = () => {
    const next = !playing;
    for (const v of previewVideos()) {
      if (next) v.play().catch(() => {});
      else v.pause();
    }
    setPlaying(next);
    if (!next) setPreviewSound(false);
  };
  const soundId = resolvedAudio !== null ? active[resolvedAudio].media?.id : undefined;
  const heardId = useRef<string | undefined>(undefined);
  /** Hear one clip in the preview (or none). Must run inside the tap: iOS only unmutes media in a user gesture. */
  const hear = (id: string | undefined) => {
    heardId.current = id;
    for (const v of previewVideos()) {
      if (id) v.currentTime = +(v.dataset.from ?? 0); // restart together (at each clip's trim), like the export
      v.muted = v.dataset.mediaId !== id;
      if (id || playing) v.play().catch(() => {});
    }
    setPreviewSound(!!id);
    if (id) setPlaying(true);
  };
  const toggleSound = () => hear(previewSound ? undefined : soundId);

  // The clip being heard changed without a tap (it was removed, replaced, or another came back by Undo):
  // iOS won't unmute the new one from an effect, so turn preview sound off rather than show it on but silent.
  useEffect(() => {
    if (previewSound && soundId !== heardId.current) setPreviewSound(false);
  }, [previewSound, soundId]);

  // One message at a time in the panel's fixed hint line, most important first.
  const hint = active.some((s) => s.media?.audioUnsupported)
    ? "This browser can't read the sound in some clips, so they'll export silent."
    : !hasSelected
      ? 'Tap a photo or video to move, zoom, reorder or remove it.'
      : anyVideo
        ? `Shorter clips loop to match the longest (max ${MAX_DURATION}s).`
        : null;

  const doExport = async (scale: 1 | 2) => {
    setChoosing(false);
    setScale(scale);
    setExportedOnce(true);
    setSelected(null);
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy({ progress: 0, label: anyVideo ? 'Rendering video…' : 'Rendering…' });
    exportStart.current = performance.now();
    diagStart();
    try {
      const { exportCollage } = await loadExporter();
      // A photo renders in a blink. Give the collage a short moment to assemble itself first, so the export reads
      // as something happening rather than a flicker (not under reduced motion).
      if (!anyVideo && !prefersReducedMotion()) {
        await new Promise<void>((done) => {
          const t0 = performance.now();
          const step = (now: number) => {
            const p = Math.min(1, (now - t0) / 1100);
            setBusy((b) => (b ? { ...b, progress: 1 - (1 - p) ** 2 } : b));
            if (p < 1) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        });
      }
      let shown = -1;
      const r = await exportCollage({
        format,
        layout,
        slots: active,
        background: bg,
        scale,
        audioFrom: resolvedAudio,
        maxDuration: MAX_DURATION,
        signal: ac.signal,
        onProgress: (p, label) => {
          // Re-render only when the visible percentage or the label changes, not on every one of up to 1,800 frames.
          const pct = Math.floor(p * 100);
          if (pct === shown && !label) return;
          shown = pct;
          setBusy((b) => (b ? { label: label ?? b.label, progress: p } : b));
        },
      });
      setResult({ ...r, url: URL.createObjectURL(r.blob) });
      setJustDone((n) => n + 1);
      navigator.vibrate?.(12); // a light tap where supported (Android); iOS ignores it
      // r.warning is shown inside the result dialog: a toast would sit outside it, unreachable behind aria-modal.
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') {
        console.error(e);
        if (isStale(e)) showStale();
        else {
          const report = diagReport(e);
          showToast({
            msg: `Export failed: ${(e as Error).message}`,
            error: true,
            action: {
              label: 'Copy details',
              run: () => void copyText(report).then((ok) => showToast(ok ? 'Details copied' : "Couldn't copy the details")),
            },
          });
        }
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const [saveError, setSaveError] = useState<string | null>(null);
  const closeResult = () => {
    setSaveError(null);
    if (result) {
      URL.revokeObjectURL(result.url);
      result.release?.().catch(() => {}); // delete the on-disk file behind it
    }
    setResult(null);
  };

  // ---------- screens ----------
  if (step === 'start') {
    return (
      <div
        className="screen start"
        onPointerMove={aimAt}
        onPointerDown={aimAt}
        onPointerLeave={() => (orbAim.current = null)}
      >
        <div className="pick-head" inert={installOpen}>
          <div>
            <h1 className="pick-title">Pick a template</h1>
            <p className="pick-sub">Stack photos or videos into one frame.</p>
          </div>
          <div className="hero-orb" ref={orbBox}>
            <Orb size={72} grid={30} intro aim={orbAim} kick={orbKick} />
          </div>
        </div>
        <main className="pick" inert={installOpen}>
          <div className="pick-row" role="group" aria-label="Number of cards">
            {([2, 3] as Count[]).map((c) => (
              <button
                key={c}
                className={pickCount === c ? 'option on' : 'option'}
                onClick={() => {
                  setPickCount(c);
                  setOrbKick((n) => n + 1);
                }}
                aria-pressed={pickCount === c}
              >
                <MiniLayout count={c} formatId={pickFormat ?? 'story'} />
                <span className="option-label">{c} cards</span>
              </button>
            ))}
          </div>
          <div className="pick-row" role="group" aria-label="Format">
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <button
                key={f}
                className={pickFormat === f ? 'option on' : 'option'}
                onClick={() => {
                  setPickFormat(f);
                  setOrbKick((n) => n + 1);
                }}
                aria-pressed={pickFormat === f}
              >
                <MiniLayout count={pickCount ?? (1 as Count)} formatId={f} />
                <span className="option-label">{FORMATS[f].label}</span>
              </button>
            ))}
          </div>
        </main>
        <button className="start-btn" disabled={!pickCount || !pickFormat} onClick={start} inert={installOpen}>
          Start
        </button>
        {/* Only in the browser: once Stack is on the Home Screen there's nothing to install. */}
        {!installed && (
          <button className="install-link" onClick={() => setInstallOpen(true)} inert={installOpen}>
            <Icon d={ICON_INSTALL} size={14} />
            Use as an app
          </button>
        )}
        {installOpen && (
          <InstallGuide
            onClose={() => setInstallOpen(false)}
            onInstall={
              installPrompt
                ? () => {
                    installPrompt.prompt().catch(() => {});
                    setInstallPrompt(null);
                  }
                : undefined
            }
          />
        )}
      </div>
    );
  }

  const sel = selected !== null ? slots[selected] : null;

  const toastView = toast && (
    <div
      className={`toast${toast.error ? ' error' : ''}${toast.error && toast.action ? ' with-action' : ''}`}
      onPointerEnter={() => setToastHeld(true)}
      onPointerLeave={() => setToastHeld(false)}
      onFocus={() => setToastHeld(true)}
      onBlur={() => setToastHeld(false)}
    >
      <span>{toast.msg}</span>
      {toast.action && (
        <button className="toast-action" onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
      {toast.error && (
        <button className="toast-dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>
          ×
        </button>
      )}
    </div>
  );

  const overlayOpen = !!busy || !!result || choosing;

  return (
    <div className="screen editor">
      {/* display: contents, so layout is unchanged; inert keeps focus and screen readers inside an open overlay */}
      <div className="editor-main" inert={overlayOpen}>
      <div className="topbar">
        <button className="icon" onClick={back} aria-label="Back">
          <Icon d={ICON_BACK} size={22} />
        </button>
        <span className="title">
          <Orb size={18} grid={14} busy={!!busy} />
          {FORMATS[formatId].label}
          <span className="title-meta" aria-hidden="true">
            {active.filter((s) => s.media).length}/{count}
          </span>
        </span>
        <button
          className="primary"
          disabled={!filled || !!busy}
          onClick={() => {
            setSnap(snapshot(format, layout, active, 540));
            setChoosing(true);
          }}
        >
          Export
        </button>
      </div>

      <Stage
        formatId={formatId}
        layout={layout}
        slots={active}
        bg={bg}
        selected={selected}
        onSelect={(i) => {
          setSelected(i);
          if (i !== null) setHasSelected(true);
        }}
        onDeselect={deselect}
        playing={playing && !busy}
        released={!!busy}
        onPlayBlocked={() => {
          // e.g. Low Power Mode blocks autoplay: show Play, so the button tells the truth.
          setPlaying(false);
          setPreviewSound(false);
        }}
        soundFrom={previewSound ? resolvedAudio : null}
        onEmptyTap={(i) => openPicker(i)}
        onTransform={setT}
        onNudge={nudge}
        onMove={moveSlot}
        onRemove={removeSlot}
        onReplace={(i) => openPicker(i)}
        onTrim={openTrim}
        trimmingId={trimId}
        scrub={scrub}
      />

      {/* Fixed height in both modes (two 48px slots), so the frame above never resizes as controls come and go. */}
      <div className="panel">
        {sel?.media?.kind === 'video' && selected !== null && sel.media.id === trimId ? (
          <div className="tools" key="trim">
            <Trimmer
              media={sel.media}
              trim={sel.trim}
              onChange={(t) => setTrim(selected, t)}
              onScrub={setScrub}
              onDone={() => setTrimId(null)}
            />
          </div>
        ) : sel && selected !== null ? (
          <div className="tools" key="edit">
            <div className="slot-a zoom-row">
              <button className="icon-btn" aria-label="Zoom out" onClick={() => nudge(selected, 0, 0, 1 / 1.15)}>
                <Icon d={ICON_ZOOM_OUT} />
              </button>
              <label htmlFor="zoom" className="visually-hidden">
                Zoom
              </label>
              <input
                id="zoom"
                type="range"
                min={1}
                max={5}
                step={0.01}
                value={sel.t.zoom}
                onChange={(e) => {
                  const z = +e.target.value;
                  setT(selected, { ...sel.t, zoom: z < 1.06 ? 1 : z }); // snaps to 1× near the end
                }}
              />
              <span className={sel.t.zoom === 1 ? 'zoom-val at-rest' : 'zoom-val'} aria-hidden="true">
                {sel.t.zoom.toFixed(1)}×
              </span>
              <button className="icon-btn" aria-label="Zoom in" onClick={() => nudge(selected, 0, 0, 1.15)}>
                <Icon d={ICON_ZOOM_IN} />
              </button>
            </div>
            <div className="slot-b">
              {/* Pans the picture inside its slot: the no-drag alternative (WCAG 2.5.7). */}
              <div className="seg move" role="group" aria-label="Move picture inside its slot">
                <span className="seg-label" aria-hidden="true">
                  Move
                </span>
                <button aria-label="Move picture left" onClick={() => nudge(selected, -0.1, 0)}>
                  <Icon d={ICON_CHEV_LEFT} />
                </button>
                <button aria-label="Move picture up" onClick={() => nudge(selected, 0, -0.1)}>
                  <Icon d={ICON_CHEV_UP} />
                </button>
                <button aria-label="Move picture down" onClick={() => nudge(selected, 0, 0.1)}>
                  <Icon d={ICON_CHEV_DOWN} />
                </button>
                <button aria-label="Move picture right" onClick={() => nudge(selected, 0.1, 0)}>
                  <Icon d={ICON_CHEV_RIGHT} />
                </button>
              </div>
              <button className="icon-btn" aria-label="Reset position and zoom" onClick={() => setT(selected, { ...IDENTITY })}>
                <Icon d={ICON_RESET} />
              </button>
              <button className="primary done" onClick={deselect}>
                Done
              </button>
            </div>
            {/* Read out with the selected slot (aria-describedby) instead of taking a line on screen. */}
            <p id="gesture-hint" className="visually-hidden">
              Drag to reposition, pinch to zoom. Arrow keys and plus or minus work too.
            </p>
          </div>
        ) : (
          <div className="tools" key="main">
            <div className="slot-a">
              {!anyVideo && (
                <p className="hint" key={hint ?? 'intro'}>
                  {active.some((s) => s.media) ? hint : 'Tap a slot to add a photo or video, or add several at once.'}
                </p>
              )}
              {anyVideo && (
                <div className="seg pop-group" role="group" aria-label="Export sound">
                  <span className="seg-label" aria-hidden="true">
                    Sound
                  </span>
                  <button
                    className={resolvedAudio === null ? 'on' : ''}
                    aria-pressed={resolvedAudio === null}
                    aria-label="No sound"
                    onClick={() => {
                      setAudioFrom(null);
                      hear(undefined);
                    }}
                  >
                    <Icon d={ICON_MUTED} />
                  </button>
                  {active.map((s, i) =>
                    s.media?.kind === 'video' && s.media.hasAudio ? (
                      <button
                        key={s.media.id}
                        className={resolvedAudio === i ? 'on pop' : 'pop'}
                        aria-pressed={resolvedAudio === i}
                        aria-label={`Sound from video ${i + 1}`}
                        onClick={() => {
                          setAudioFrom(s.media!.id);
                          hear(s.media!.id); // picking a clip's sound plays it in the preview too
                        }}
                      >
                        {i + 1}
                      </button>
                    ) : null,
                  )}
                </div>
              )}
              {anyVideo && (
                <div className="seg pop-group" role="group" aria-label="Preview">
                  {/* The name says the state, so no aria-pressed: a toggle shouldn't change both. */}
                  <button aria-label={playing ? 'Pause preview' : 'Play preview'} onClick={togglePlaying}>
                    <Icon d={playing ? ICON_PAUSE : ICON_PLAY} />
                  </button>
                  {resolvedAudio !== null && (
                    <button
                      className={previewSound ? 'on pop' : 'pop'}
                      aria-pressed={previewSound}
                      aria-label="Sound in preview"
                      onClick={toggleSound}
                    >
                      <Icon d={previewSound ? ICON_SPEAKER : ICON_MUTED} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="slot-b">
              {!filled ? (
                <button className="primary wide add" onClick={() => openPicker('fill')}>
                  Add photos or videos
                  <span className="count" aria-label={`, ${active.filter((s) => s.media).length} of ${count} added`}>
                    {active.filter((s) => s.media).length}/{count}
                  </span>
                </button>
              ) : (
                anyVideo &&
                hint && (
                  <p className="hint" key={hint}>
                    {hint}
                  </p>
                )
              )}
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(e) => onFiles(e.target.files)}
      />
      </div>

      {choosing && (
        <Dialog
          label="Export size"
          className="choose"
          onEscape={() => setChoosing(false)}
          returnFocus={() => document.querySelector<HTMLElement>('.topbar .primary')}
        >
          <p className="sheet-title">Export</p>
          {snap && <LookPreview source={snap} width={150} />}
          {([1, 2] as const).map((k) => (
            <button key={k} className={exportedOnce && k === scale ? 'size-option last' : 'size-option'} onClick={() => doExport(k)}>
              <span className="size-name">
                {k === 1 ? 'Standard' : 'High quality'}
                {exportedOnce && k === scale && <span className="size-tag">Last used</span>}
              </span>
              <span className="size-meta">
                <span className="mono">{format.w * k}×{format.h * k}</span> · {k === 1 ? 'right for Instagram and most apps' : 'sharper, about 2× the file size'}
              </span>
            </button>
          ))}
          <button className="wide" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </Dialog>
      )}

      {busy && (
        <Dialog
          label={busy.label}
          className="busy"
          onEscape={anyVideo ? () => abortRef.current?.abort() : undefined}
          returnFocus={() => document.querySelector<HTMLElement>('[data-slot]')}
        >
          {snap && busy.progress >= 0 ? (
            <LookPreview source={snap} width={132} reveal={Math.max(0.02, busy.progress)} />
          ) : (
            <Orb size={88} grid={36} busy />
          )}
          <p role="status" className="busy-label">
            {snap && busy.progress >= 0 && <Orb size={18} grid={14} busy />}
            {busy.label}
          </p>
          {busy.progress >= 0 && (
            <>
              <div
                className="bar"
                role="progressbar"
                aria-label={busy.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(busy.progress * 100)}
              >
                <div style={{ width: `${Math.round(busy.progress * 100)}%` }} />
              </div>
              <p className="pct" aria-hidden="true">
                {timeLeft(busy.progress, exportStart.current)}
                {String(Math.round(busy.progress * 100)).padStart(2, '0')}%
              </p>
              {anyVideo && (
                <button className="wide" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              )}
            </>
          )}
        </Dialog>
      )}

      {result && (
        <Dialog
          label="Export ready"
          className="result"
          onEscape={closeResult}
          returnFocus={() => document.querySelector<HTMLElement>('.topbar .primary')}
        >
            <p className="result-head">
              <span className="done-orb">
                <Orb size={18} grid={14} kick={justDone} />
              </span>
              Ready
            </p>
            {result.blob.type.startsWith('video') ? (
              <video src={result.url} autoPlay loop muted playsInline controls />
            ) : (
              <img src={result.url} alt="Exported collage" />
            )}
            <p className="muted mono">
              {format.w * scale}×{format.h * scale} · {(result.blob.size / 1e6).toFixed(1)} MB
            </p>
            {result.warning && <p className="sheet-note">{result.warning}</p>}
            {saveError && (
              <p className="sheet-note" role="alert">
                {saveError}
              </p>
            )}
            <button
              className="primary wide"
              onClick={() => {
                setSaveError(null);
                loadExporter()
                  .then(({ saveResult }) => saveResult(result))
                  .catch((e) => setSaveError((e as Error).message));
              }}
            >
              Save
            </button>
            <button className="wide" onClick={closeResult}>
              Back to editing
            </button>
        </Dialog>
      )}

      {/* Two live regions, always in the DOM so screen readers announce what's inserted: errors interrupt, the
          rest waits its turn. (role="alert" nested in a polite region can be read twice.) */}
      <div className="toast-region" aria-live="polite">
        {toast && !toast.error && toastView}
      </div>
      <div className="toast-region" aria-live="assertive">
        {toast?.error && toastView}
      </div>
    </div>
  );
}

/** "about 8s left · " once there's enough progress to guess from; nothing before that. */
function timeLeft(p: number, start: number) {
  const elapsed = (performance.now() - start) / 1000;
  if (p < 0.05 || p >= 1 || elapsed < 1.5) return '';
  const left = (elapsed * (1 - p)) / p;
  return left >= 90 ? `about ${Math.round(left / 60)} min left · ` : `about ${Math.max(1, Math.round(left))}s left · `;
}

function MiniLayout({ count, formatId }: { count: Count; formatId: FormatId }) {
  const f = FORMATS[formatId];
  const rects = computeSlots(f, defaultLayout(count, formatId));
  const gap = 14;
  return (
    <div className="mini-box">
      <svg viewBox={`0 0 ${f.w} ${f.h}`} className="mini" aria-hidden="true">
        {rects.map((r, i) => (
          <rect
            key={i}
            x={0}
            y={r.y + (i === 0 ? 0 : gap / 2)}
            width={f.w}
            height={r.h - (i > 0 ? gap / 2 : 0) - (i < count - 1 ? gap / 2 : 0)}
            rx={36}
            className={`tile t${i}`}
          />
        ))}
      </svg>
    </div>
  );
}

// ---------- Install guide: how to put Stack on the Home Screen ----------

function InstallGuide({ onClose, onInstall }: { onClose: () => void; onInstall?: () => void }) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Chrome on iPhone says CriOS; anywhere other than an iPhone, Chrome is the one that matters.
  const [browser, setBrowser] = useState<'safari' | 'chrome'>(ios && !/CriOS/.test(ua) ? 'safari' : 'chrome');
  const steps =
    browser === 'safari'
      ? [
          { icon: ICON_SHARE, text: <>Tap <b>Share</b> in the toolbar</> },
          { icon: ICON_PLUS_SQUARE, text: <>Scroll down and tap <b>Add to Home Screen</b></> },
          { icon: ICON_INSTALL, text: <>Tap <b>Add</b>. Stack is now on your Home Screen</> },
        ]
      : ios
        ? [
            { icon: ICON_SHARE, text: <>Tap <b>Share</b> in the address bar, top right</> },
            { icon: ICON_PLUS_SQUARE, text: <>Scroll down and tap <b>Add to Home Screen</b></> },
            { icon: ICON_INSTALL, text: <>Tap <b>Add</b>. Stack is now on your Home Screen</> },
          ]
        : [
            { icon: ICON_MENU_DOTS, text: <>Tap the <b>⋮</b> menu</> },
            { icon: ICON_PLUS_SQUARE, text: <>Tap <b>Install app</b> or <b>Add to Home screen</b></> },
            { icon: ICON_INSTALL, text: <>Tap <b>Install</b>. Stack is now with your apps</> },
          ];
  return (
    <Dialog label="Use Stack as an app" className="install" onEscape={onClose}>
      <Orb size={56} grid={24} />
      <p className="sheet-title">Use Stack as an app</p>
      <p className="muted install-sub">
        Add it to your Home Screen. It opens full screen, works offline, and your photos never leave the phone.
      </p>
      {onInstall ? (
        <button className="primary wide" onClick={onInstall}>
          Install Stack
        </button>
      ) : (
        <>
          <div className="tabs" role="group" aria-label="Browser">
            {(['safari', 'chrome'] as const).map((b) => (
              <button key={b} className={browser === b ? 'on' : ''} aria-pressed={browser === b} onClick={() => setBrowser(b)}>
                {b === 'safari' ? 'Safari' : 'Chrome'}
              </button>
            ))}
            <span className="tabs-line" style={{ transform: `translateX(${browser === 'safari' ? 0 : 100}%)` }} aria-hidden="true" />
          </div>
          <ol className="install-steps" key={browser}>
            {steps.map((st, i) => (
              <li key={i}>
                <span className="step-icon" aria-hidden="true">
                  <Icon d={st.icon} size={16} />
                </span>
                <span>{st.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <button className="wide" onClick={onClose}>
        Done
      </button>
    </Dialog>
  );
}

// ---------- Dialog: focus moves in, background is inert (set by the caller), Escape closes ----------

function Dialog(props: {
  label: string;
  className?: string;
  onEscape?: () => void;
  /** Where focus goes when the dialog closes if it can't go back where it was (that control is gone, or focus was
   *  never on one). */
  returnFocus?: () => HTMLElement | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(props.returnFocus);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    (el.querySelector<HTMLElement>('button') ?? el).focus();
    // Restore after React has lifted `inert` from the page behind, or the target can't take focus.
    return () =>
      void setTimeout(() => {
        const back = prev && prev !== document.body && prev.isConnected ? prev : returnFocus.current?.();
        back?.focus();
      });
  }, []);
  return (
    <div className="overlay">
      <div
        ref={ref}
        className={props.className ? `sheet ${props.className}` : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && props.onEscape) {
            e.stopPropagation();
            props.onEscape();
          }
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

// ---------- Stage: live preview + gestures ----------

interface StageProps {
  formatId: FormatId;
  layout: LayoutOpts;
  slots: SlotState[];
  bg: string;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onDeselect: () => void;
  onEmptyTap: (i: number) => void;
  onTransform: (i: number, t: Transform) => void;
  onNudge: (i: number, dx: number, dy: number, dz?: number) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onRemove: (i: number) => void;
  onReplace: (i: number) => void;
  onTrim: (i: number) => void;
  /** The clip whose trimmer is open, and the time (seconds into it) to hold while a trim handle is dragged. */
  trimmingId: string | null;
  scrub: number | null;
  playing: boolean;
  /** Unload the preview's videos (while exporting), each showing a still of its frame. */
  released: boolean;
  /** Index of the slot whose sound plays in the preview, if any. */
  soundFrom: number | null;
  onPlayBlocked: () => void;
}

function Stage(p: StageProps) {
  const f = FORMATS[p.formatId];
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = wrap.current!;
    // contentRect excludes .stage-wrap's padding, so the frame fits the space it actually gets.
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      const s = Math.min(r.width / f.w, r.height / f.h);
      setSize({ w: f.w * s, h: f.h * s });
      // The panel's controls line up with the frame's edges, not the screen's.
      el.closest<HTMLElement>('.editor')?.style.setProperty('--stage-w', `${f.w * s}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [f.w, f.h]);

  const s = size.w / f.w;
  const rects = computeSlots(f, p.layout);
  const n = p.slots.length;

  return (
    <div className="stage-wrap" ref={wrap} onPointerDown={(e) => e.target === e.currentTarget && p.onSelect(null)}>
      <div className="stage" style={{ width: size.w, height: size.h }}>
        {s > 0 &&
          p.slots.map((slot, i) => (
            <SlotView
              key={slot.media?.id ?? `empty${i}`}
              index={i}
              count={n}
              rect={rects[i]}
              s={s}
              radius={p.layout.radius}
              slot={slot}
              selected={p.selected === i}
              playing={p.playing}
              released={p.released}
              sound={p.soundFrom === i}
              onPlayBlocked={p.onPlayBlocked}
              onTap={() => (slot.media ? p.onSelect(i) : p.onEmptyTap(i))}
              onTransform={(t) => p.onTransform(i, t)}
              onNudge={(dx, dy, dz) => p.onNudge(i, dx, dy, dz)}
              onDeselect={p.onDeselect}
              onGestureStart={() => slot.media && p.onSelect(i)}
              onUp={i > 0 ? () => p.onMove(i, -1) : undefined}
              onDown={i < n - 1 ? () => p.onMove(i, 1) : undefined}
              onRemove={() => p.onRemove(i)}
              onReplace={() => p.onReplace(i)}
              onTrim={slot.media?.kind === 'video' ? () => p.onTrim(i) : undefined}
              trimming={!!slot.media && slot.media.id === p.trimmingId}
              scrub={slot.media && slot.media.id === p.trimmingId ? p.scrub : null}
            />
          ))}
      </div>
    </div>
  );
}

interface SlotViewProps {
  index: number;
  count: number;
  rect: Rect;
  s: number;
  radius: number;
  slot: SlotState;
  selected: boolean;
  playing: boolean;
  released: boolean;
  sound: boolean;
  onPlayBlocked: () => void;
  onTap: () => void;
  onTransform: (t: Transform) => void;
  onNudge: (dx: number, dy: number, dz?: number) => void;
  onDeselect: () => void;
  onGestureStart: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
  onReplace: () => void;
  /** Video slots only: open the trimmer. */
  onTrim?: () => void;
  trimming: boolean;
  scrub: number | null;
}

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICON_INSTALL = 'M12 3v12M7 10l5 5 5-5M5 21h14';
const ICON_SHARE = 'M12 3v13M7 8l5-5 5 5M5 12v8h14v-8';
const ICON_PLUS_SQUARE = 'M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM12 8v8M8 12h8';
const ICON_MENU_DOTS = 'M12 5h.01M12 12h.01M12 19h.01';
const ICON_BACK = 'M15 18l-6-6 6-6';
const ICON_UP = 'M12 19V5M5 12l7-7 7 7';
const ICON_DOWN = 'M12 5v14M19 12l-7 7-7-7';
const ICON_LEFT = 'M19 12H5M12 19l-7-7 7-7';
const ICON_RIGHT = 'M5 12h14M12 5l7 7-7 7';
const ICON_PLAY = 'M7 4.5l12 7.5-12 7.5z';
const ICON_PAUSE = 'M8 5v14M16 5v14';
const ICON_MUTED = 'M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6';
const ICON_SPEAKER = 'M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13';
const ICON_CHEV_LEFT = 'M15 6l-6 6 6 6';
const ICON_CHEV_RIGHT = 'M9 6l6 6-6 6';
const ICON_CHEV_UP = 'M6 15l6-6 6 6';
const ICON_CHEV_DOWN = 'M6 9l6 6 6-6';
const ICON_ZOOM_IN = 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6M11 8v6';
const ICON_ZOOM_OUT = 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6';
const ICON_RESET = 'M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5';
const ICON_REPLACE = 'M16 3l4 4-4 4M20 7H8a4 4 0 00-4 4M8 21l-4-4 4-4M4 17h12a4 4 0 004-4';
const ICON_SCISSORS = 'M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12';
const ICON_TRASH = 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6';

function slotLabel(index: number, count: number, slot: SlotState, selected: boolean) {
  const m = slot.media;
  const where = `Slot ${index + 1} of ${count}`;
  if (!m) return `${where}, empty. Add a photo or video`;
  const what = m.kind === 'video' ? `video, ${clipLength(m, slot.trim).toFixed(1)} seconds` : 'photo';
  return `${where}, ${what}${selected ? ', selected' : ''}`;
}

function SlotView(props: SlotViewProps) {
  const { index, count, rect, s, radius, slot, selected, onTap, onTransform, onNudge, onDeselect, onGestureStart } = props;
  const { onUp, onDown, onRemove, onReplace, onTrim, trimming, scrub, playing, released, sound, onPlayBlocked } = props;
  const onPlayBlockedRef = useRef(onPlayBlocked);
  onPlayBlockedRef.current = onPlayBlocked;
  const m = slot.media;
  const el = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  // Keep the element in step with the preview state (React doesn't reliably update `muted` as a prop).
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = !sound;
    if (playing) {
      v.play().catch((e: DOMException) => {
        if (e.name === 'NotAllowedError') onPlayBlockedRef.current(); // AbortError just means a pause() won
      });
    }
    else v.pause();
  }, [playing, sound]);

  // While exporting, unload the video. On iPhone each loaded <video> can hold a hardware decoder, even paused, and
  // the export needs those for its own decoders and encoder ("Decoding task failed", "encoder configuration ... not
  // supported"). A still of the current frame stands in. When export ends, React runs this cleanup before the
  // play effect above, so the source is back before play() is called.
  useEffect(() => {
    const v = video.current;
    if (!v || !released || !m) return;
    v.pause();
    const t = v.currentTime;
    let poster: string | null = null;
    try {
      const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight, 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(v.videoWidth * k));
      c.height = Math.max(1, Math.round(v.videoHeight * k));
      if (v.videoWidth) {
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        poster = c.toDataURL('image/jpeg', 0.85);
        v.poster = poster;
      }
    } catch {
      // no still: the slot shows the background for the length of the export
    }
    v.removeAttribute('src');
    v.load();
    return () => {
      v.src = m.url;
      v.currentTime = t;
      const clear = () => poster && v.poster === poster && v.removeAttribute('poster');
      v.addEventListener('loadeddata', clear, { once: true });
    };
  }, [released, m]);

  // Trimmed clips loop over just the kept part. `loop` still covers an untrimmed clip (and a trim that runs to the
  // end); this watch brings playback back to the trim's start whenever it leaves the range.
  const range = m?.kind === 'video' ? trimOf(m, slot.trim) : null;
  const from = m && range ? m.start + range.in : 0;
  const to = m && range ? m.start + range.out : 0;
  const trimmed = !!m && m.kind === 'video' && isTrimmed(m, slot.trim);
  const scrubbing = scrub !== null;
  useEffect(() => {
    const v = video.current;
    if (!v || !trimmed || scrubbing) return;
    let raf = 0;
    const check = () => {
      if (!v.seeking && (v.currentTime >= to - 0.02 || v.currentTime < from - 0.05)) v.currentTime = from;
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [trimmed, from, to, scrubbing]);

  // While a trim handle is dragged, hold the frame under it; seeks queue so a fast drag doesn't pile them up.
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onSeeked = () => {
      const t = pendingSeek.current;
      pendingSeek.current = null;
      if (t !== null) v.currentTime = t;
    };
    v.addEventListener('seeked', onSeeked);
    return () => v.removeEventListener('seeked', onSeeked);
  }, [m]);
  useEffect(() => {
    const v = video.current;
    if (!v || !m || scrub === null) return;
    v.pause();
    const t = m.start + scrub;
    if (v.seeking) pendingSeek.current = t;
    else v.currentTime = t;
  }, [scrub, m]);
  // Drag over: play the kept part from its start.
  const wasScrubbing = useRef(false);
  useEffect(() => {
    const v = video.current;
    if (wasScrubbing.current && !scrubbing && v) {
      pendingSeek.current = null;
      v.currentTime = from;
      if (playingRef.current) v.play().catch(() => {});
    }
    wasScrubbing.current = scrubbing;
  }, [scrubbing]);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: number; startT: Transform; pinchDist?: number } | null>(null);
  // A drag or pinch ends with a click like any tap would: swallow that one.
  const suppressClick = useRef(false);
  const tRef = useRef(slot.t);
  tRef.current = slot.t;

  const apply = (next: Transform) => {
    if (!m) return;
    const t = { zoom: clamp(next.zoom, 1, 5), x: clamp(next.x, -1, 1), y: clamp(next.y, -1, 1) };
    tRef.current = t; // keep successive pointer moves consistent before React re-renders
    onTransform(t);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture.current) {
      gesture.current = { moved: 0, startT: tRef.current };
      suppressClick.current = false;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      onGestureStart();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !gesture.current || !m) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    const t = tRef.current;
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.pinchDist) apply({ ...t, zoom: (t.zoom * d) / gesture.current.pinchDist });
      gesture.current.pinchDist = d;
      gesture.current.moved += 10;
      return;
    }
    const dx = (cur.x - prev.x) / s;
    const dy = (cur.y - prev.y) / s;
    gesture.current.moved += Math.abs(dx * s) + Math.abs(dy * s);
    if (gesture.current.moved > 6) {
      if (!selected) onGestureStart();
      const ov = overflow(rect, m.w, m.h, t.zoom);
      apply({ ...t, x: ov.x > 0 ? t.x + dx / ov.x : 0, y: ov.y > 0 ? t.y + dy / ov.y : 0 });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 1 && gesture.current) gesture.current.pinchDist = undefined;
    if (pointers.current.size === 0) {
      if (gesture.current && gesture.current.moved > 6) {
        suppressClick.current = true;
        // Touch browsers send no click after a moved touch: don't let the flag swallow a later keyboard or
        // VoiceOver click. A click that does follow is dispatched before this timer runs.
        window.setTimeout(() => (suppressClick.current = false));
      }
      gesture.current = null;
    }
  };

  // The system took the touch (a notification, an OS gesture): end the gesture without counting it as a tap.
  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    else if (gesture.current) gesture.current.pinchDist = undefined;
  };

  // Taps arrive as clicks: from a finger, a mouse, Enter/Space on the focused slot, or a screen reader's activate.
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onTap();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!m || !selected) return; // Enter/Space select first; then arrows, +/- and Escape adjust
    const step = e.shiftKey ? 0.25 : 0.1;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => onNudge(-step, 0),
      ArrowRight: () => onNudge(step, 0),
      ArrowUp: () => onNudge(0, -step),
      ArrowDown: () => onNudge(0, step),
      '+': () => onNudge(0, 0, 1.1),
      '=': () => onNudge(0, 0, 1.1),
      '-': () => onNudge(0, 0, 1 / 1.1),
      Escape: onDeselect,
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };

  // Zoom with the wheel (selected slot only, so scrolling over the frame doesn't change it by accident) or a
  // trackpad pinch (any slot). Listen natively: React's wheel handler is passive and can't stop the page zooming
  // too. Chrome sends a pinch as ctrl+wheel; Safari sends gesture events.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!m) return;
    const node = el.current!;
    const zoomBy = (f: number) => applyRef.current({ ...tRef.current, zoom: tRef.current.zoom * f });
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !selectedRef.current) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY / (e.ctrlKey ? 100 : 400))); // pinch deltas are small
    };
    let zoom0 = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      zoom0 = tRef.current.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      // On iOS a touch pinch also fires these, but pointer events already handle it.
      if (pointers.current.size > 0) return;
      zoomBy((zoom0 * (e as Event & { scale: number }).scale) / tRef.current.zoom);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('gesturestart', onGestureStart);
    node.addEventListener('gesturechange', onGestureChange);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart);
      node.removeEventListener('gesturechange', onGestureChange);
    };
  }, [m]);

  const d = m ? mediaRect(rect, m.w, m.h, slot.t) : null;
  const mediaStyle: React.CSSProperties | undefined = d
    ? { left: (d.x - rect.x) * s, top: (d.y - rect.y) * s, width: d.w * s, height: d.h * s }
    : undefined;

  return (
    <div
      ref={el}
      className={`slot${selected ? ' selected' : ''}${m ? '' : ' empty'}`}
      style={{ left: rect.x * s, top: rect.y * s, width: rect.w * s, height: rect.h * s, borderRadius: radius * s }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
    >
      {m?.kind === 'image' && <img src={m.url} style={mediaStyle} draggable={false} alt="" />}
      {m?.kind === 'video' && (
        <video ref={video} data-media-id={m.id} data-from={from} src={m.url} style={mediaStyle} loop muted playsInline preload="auto" />
      )}
      {!m && (
        <div className="placeholder" aria-hidden="true">
          <DitherField />
          <span className="plus">
            <Icon d="M12 5v14M5 12h14" size={16} />
          </span>
          <span className="slot-num">{String(index + 1).padStart(2, '0')}</span>
        </div>
      )}
      {/* The slot's keyboard and screen-reader handle. Its click bubbles to the slot's onClick. */}
      <button
        className="slot-hit"
        data-slot={index}
        aria-label={slotLabel(index, count, slot, selected)}
        aria-keyshortcuts={m && selected ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Plus - Escape' : undefined}
        aria-describedby={m && selected ? 'gesture-hint' : undefined}
        onKeyDown={onKeyDown}
      />
      {m?.kind === 'video' && onTrim && (
        <button
          className={trimmed ? 'badge trimmed' : 'badge'}
          aria-label={`Trim clip, ${clipLength(m, slot.trim).toFixed(1)} seconds${trimmed ? ', trimmed' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onTrim();
          }}
        >
          {trimmed && <Icon d={ICON_SCISSORS} size={11} />}
          {clipLength(m, slot.trim).toFixed(1)}s
        </button>
      )}
      {m && selected && (
        <div className="slot-actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {onUp && (
            <button aria-label={`Move slot ${index + 1} up`} onClick={onUp}>
              <Icon d={ICON_UP} />
            </button>
          )}
          {onDown && (
            <button aria-label={`Move slot ${index + 1} down`} onClick={onDown}>
              <Icon d={ICON_DOWN} />
            </button>
          )}
          {onTrim && (
            <button aria-label={`Trim clip in slot ${index + 1}`} aria-pressed={trimming} className={trimming ? 'on' : undefined} onClick={onTrim}>
              <Icon d={ICON_SCISSORS} />
            </button>
          )}
          <button aria-label={`Replace slot ${index + 1}`} onClick={onReplace}>
            <Icon d={ICON_REPLACE} />
          </button>
          <button aria-label={`Remove slot ${index + 1}`} className="danger" onClick={onRemove}>
            <Icon d={ICON_TRASH} />
          </button>
        </div>
      )}
    </div>
  );
}
