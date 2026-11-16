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
import { loadMedia, releaseMedia, type Media } from './media';
import type { ExportResult, SlotState } from './exporter';

// The exporter pulls in mediabunny (~200 KB gzipped). Load it when it's first needed, not on startup.
const loadExporter = () => import('./exporter');
const hasVideo = (slots: SlotState[]) => slots.some((s) => s.media?.kind === 'video');

type Step = 'start' | 'editor';

const MAX_DURATION = 60;

const emptySlots = (): SlotState[] => [0, 1, 2].map(() => ({ media: null, t: { ...IDENTITY } }));

interface Toast {
  msg: string;
  /** Errors stay until dismissed; everything else hides itself. */
  error?: boolean;
  action?: { label: string; run: () => void };
}

const UNDO_MS = 6000;

// React StrictMode runs effects twice in development: make sure the history fix-up below runs once.
let historyNormalized = false;

export default function App() {
  const [step, setStep] = useState<Step>('start');
  const [count, setCount] = useState<Count>(3);
  const [formatId, setFormatId] = useState<FormatId>('story');
  const [pickCount, setPickCount] = useState<Count | null>(null);
  const [pickFormat, setPickFormat] = useState<FormatId | null>(null);
  const [layout, setLayout] = useState<LayoutOpts>(defaultLayout(3, 'story'));
  const bg = '#000000'; // never visible: slots always fill the frame
  const [slots, setSlots] = useState<SlotState[]>(emptySlots);
  const [scale, setScale] = useState<1 | 2>(1);
  // Which clip's sound to use: a media id (so the choice follows the clip when slots are reordered), 'auto', or off.
  const [audioFrom, setAudioFrom] = useState<string | 'auto' | null>('auto');
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState<{ progress: number; label: string } | null>(null);
  const [result, setResult] = useState<(ExportResult & { url: string }) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The strip iOS reserves below a Home Screen app shows the page background: match whatever sits at the bottom.
  useEffect(() => {
    const c = step === 'editor' ? '#161618' : '#09090b';
    document.documentElement.style.backgroundColor = c;
    document.body.style.backgroundColor = c;
  }, [step]);

  const format = FORMATS[formatId];
  const active = slots.slice(0, count);
  const anyVideo = hasVideo(active);
  const filled = active.every((s) => s.media);

  const showToast = useCallback((t: Toast | string) => setToast(typeof t === 'string' ? { msg: t } : t), []);
  const showError = useCallback((msg: string) => showToast({ msg, error: true }), [showToast]);

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
    for (let j = 0; j < list.length; j++) {
      try {
        const m = await loadMedia(list[j]);
        const idx = indices[j];
        // What's being replaced, from the latest render (outside the updater: StrictMode runs updaters twice).
        releaseMedia(slotsRef.current[idx].media);
        setSlots((prev) => prev.map((s, k) => (k === idx ? { media: m, t: { ...IDENTITY } } : s)));
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    setBusy(null);
    if (errors.length) showError(errors.join(' '));
    else if (files.length > list.length) {
      showToast(`Added ${list.length} of ${files.length}: only ${list.length} slot${list.length === 1 ? ' was' : 's were'} empty.`);
    }
  };

  // ---------- slot ops ----------
  const setT = (i: number, t: Transform) =>
    setSlots((prev) => prev.map((s, k) => (k === i ? { ...s, t } : s)));

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
  };

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

  const doExport = async () => {
    setSelected(null);
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy({ progress: 0, label: anyVideo ? 'Rendering video…' : 'Rendering…' });
    try {
      const { exportCollage } = await loadExporter();
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
      if (r.warning) showError(r.warning);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') {
        console.error(e);
        showError(`Export failed: ${(e as Error).message}`);
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const closeResult = () => {
    if (result) {
      URL.revokeObjectURL(result.url);
      result.release?.().catch(() => {}); // delete the on-disk file behind it
    }
    setResult(null);
  };

  // ---------- screens ----------
  if (step === 'start') {
    return (
      <div className="screen start">
        <h1 className="pick-title">Pick your template</h1>
        <main className="pick">
          <div className="pick-row">
            {([2, 3] as Count[]).map((c) => (
              <button
                key={c}
                className={pickCount === c ? 'option on' : 'option'}
                onClick={() => setPickCount(c)}
                aria-label={`${c} stacked`}
                aria-pressed={pickCount === c}
              >
                <MiniLayout count={c} formatId={pickFormat ?? 'story'} />
                <span className="option-label">{c} cards</span>
              </button>
            ))}
          </div>
          <div className="pick-row">
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <button
                key={f}
                className={pickFormat === f ? 'option on' : 'option'}
                onClick={() => setPickFormat(f)}
                aria-label={FORMATS[f].label}
                aria-pressed={pickFormat === f}
              >
                <MiniLayout count={pickCount ?? (1 as Count)} formatId={f} />
                <span className="option-label">{FORMATS[f].label}</span>
              </button>
            ))}
          </div>
        </main>
        <button className="start-btn" disabled={!pickCount || !pickFormat} onClick={start}>
          Start
        </button>
      </div>
    );
  }

  const sel = selected !== null ? slots[selected] : null;

  return (
    <div className="screen editor">
      <div className="topbar">
        <button className="icon" onClick={back} aria-label="Back">
          <Icon d={ICON_BACK} size={22} />
        </button>
        <span className="title">
          {FORMATS[formatId].label}
        </span>
        <button className="primary" disabled={!filled || !!busy} onClick={doExport}>
          Export
        </button>
      </div>

      <Stage
        formatId={formatId}
        layout={layout}
        slots={active}
        bg={bg}
        selected={selected}
        onSelect={(i) => setSelected(i)}
        onEmptyTap={(i) => openPicker(i)}
        onTransform={setT}
        onMove={moveSlot}
        onRemove={removeSlot}
      />

      <div className="panel">
        {sel && selected !== null ? (
          <div className="tools">
            <div className="row">
              <label>Zoom</label>
              <input
                type="range"
                min={1}
                max={5}
                step={0.01}
                value={sel.t.zoom}
                onChange={(e) => setT(selected, { ...sel.t, zoom: +e.target.value })}
              />
            </div>
            <div className="buttons">
              <button onClick={() => openPicker(selected)}>Replace</button>
              <button onClick={() => setT(selected, { ...IDENTITY })}>Reset</button>
              <button className="primary" onClick={() => setSelected(null)}>
                Done
              </button>
            </div>
            <p className="hint">Drag to reposition · pinch to zoom</p>
          </div>
        ) : (
          <div className="tools">
            {!filled && (
              <button className="primary wide" onClick={() => openPicker('fill')}>
                Add photos or videos
              </button>
            )}
            {!filled && (
              <p className="hint">
                Fill all {count} slots to export · {active.filter((s) => s.media).length} of {count} done
              </p>
            )}
            <div className="row end">
              <label>Size</label>
              <div className="chips">
                <button className={scale === 1 ? 'chip on' : 'chip'} onClick={() => setScale(1)}>
                  Standard
                </button>
                <button className={scale === 2 ? 'chip on' : 'chip'} onClick={() => setScale(2)}>
                  High · 2×
                </button>
              </div>
            </div>
            {anyVideo && (
              <div className="row end">
                <label>Sound</label>
                <div className="chips">
                  <button className={resolvedAudio === null ? 'chip on' : 'chip'} onClick={() => setAudioFrom(null)}>
                    Off
                  </button>
                  {active.map((s, i) =>
                    s.media?.kind === 'video' && s.media.hasAudio ? (
                      <button
                        key={i}
                        className={resolvedAudio === i ? 'chip on' : 'chip'}
                        onClick={() => setAudioFrom(s.media!.id)}
                      >
                        Video {i + 1}
                      </button>
                    ) : null,
                  )}
                </div>
              </div>
            )}
            {active.some((s) => s.media?.audioUnsupported) && (
              <p className="hint">This browser can't read the sound in some clips, so they'll export silent.</p>
            )}
            {anyVideo && <p className="hint">Shorter clips loop to match the longest (max {MAX_DURATION}s).</p>}
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

      {busy && (
        <div className="overlay">
          <div className="sheet">
            <p>{busy.label}</p>
            {busy.progress >= 0 && (
              <>
                <div className="bar">
                  <div style={{ width: `${Math.round(busy.progress * 100)}%` }} />
                </div>
                <p className="muted">{Math.round(busy.progress * 100)}%</p>
                {anyVideo && <button onClick={() => abortRef.current?.abort()}>Cancel</button>}
              </>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="overlay">
          <div className="sheet result">
            {result.blob.type.startsWith('video') ? (
              <video src={result.url} autoPlay loop muted playsInline controls />
            ) : (
              <img src={result.url} alt="Exported collage" />
            )}
            <p className="muted">
              {format.w * scale}×{format.h * scale} · {(result.blob.size / 1e6).toFixed(1)} MB
            </p>
            <button
              className="primary wide"
              onClick={() =>
                loadExporter()
                  .then(({ saveResult }) => saveResult(result))
                  .catch((e) => showError((e as Error).message))
              }
            >
              Save
            </button>
            <button className="wide" onClick={closeResult}>
              Back to editing
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={toast.error ? 'toast error' : 'toast'}
          onPointerEnter={() => setToastHeld(true)}
          onPointerLeave={() => setToastHeld(false)}
          onFocus={() => setToastHeld(true)}
          onBlur={() => setToastHeld(false)}
        >
          <span>{toast.msg}</span>
          {toast.action && <button onClick={toast.action.run}>{toast.action.label}</button>}
          {toast.error && (
            <button aria-label="Dismiss" onClick={() => setToast(null)}>
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MiniLayout({ count, formatId }: { count: Count; formatId: FormatId }) {
  const f = FORMATS[formatId];
  const rects = computeSlots(f, defaultLayout(count, formatId));
  const gap = 14;
  return (
    <div className="mini-box">
      <svg viewBox={`0 0 ${f.w} ${f.h}`} className="mini">
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

// ---------- Stage: live preview + gestures ----------

interface StageProps {
  formatId: FormatId;
  layout: LayoutOpts;
  slots: SlotState[];
  bg: string;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onEmptyTap: (i: number) => void;
  onTransform: (i: number, t: Transform) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onRemove: (i: number) => void;
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
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [f.w, f.h]);

  const s = size.w / f.w;
  const rects = computeSlots(f, p.layout);

  return (
    <div className="stage-wrap" ref={wrap} onPointerDown={(e) => e.target === e.currentTarget && p.onSelect(null)}>
      <div className="stage" style={{ width: size.w, height: size.h, background: p.bg }}>
        {s > 0 &&
          p.slots.map((slot, i) => (
            <SlotView
              key={slot.media?.id ?? `empty${i}`}
              index={i}
              rect={rects[i]}
              s={s}
              radius={p.layout.radius}
              slot={slot}
              selected={p.selected === i}
              onTap={() => (slot.media ? p.onSelect(i) : p.onEmptyTap(i))}
              onTransform={(t) => p.onTransform(i, t)}
              onGestureStart={() => slot.media && p.onSelect(i)}
              onUp={i > 0 ? () => p.onMove(i, -1) : undefined}
              onDown={i < p.slots.length - 1 ? () => p.onMove(i, 1) : undefined}
              onRemove={() => p.onRemove(i)}
            />
          ))}
      </div>
    </div>
  );
}

interface SlotViewProps {
  index: number;
  rect: Rect;
  s: number;
  radius: number;
  slot: SlotState;
  selected: boolean;
  onTap: () => void;
  onTransform: (t: Transform) => void;
  onGestureStart: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
}

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICON_BACK = 'M15 18l-6-6 6-6';
const ICON_UP = 'M12 19V5M5 12l7-7 7 7';
const ICON_DOWN = 'M12 5v14M19 12l-7 7-7-7';
const ICON_TRASH = 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6';

function SlotView(props: SlotViewProps) {
  const { index, rect, s, radius, slot, selected, onTap, onTransform, onGestureStart, onUp, onDown, onRemove } = props;
  const m = slot.media;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: number; startT: Transform; pinchDist?: number } | null>(null);
  const tRef = useRef(slot.t);
  tRef.current = slot.t;

  const apply = (next: Transform) => {
    if (!m) return;
    const t = { zoom: clamp(next.zoom, 1, 5), x: clamp(next.x, -1, 1), y: clamp(next.y, -1, 1) };
    tRef.current = t; // keep successive pointer moves consistent before React re-renders
    onTransform(t);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture.current) gesture.current = { moved: 0, startT: tRef.current };
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
      if (gesture.current && gesture.current.moved <= 6) onTap();
      gesture.current = null;
    }
  };

  // The system took the touch (a notification, an OS gesture): end the gesture without counting it as a tap.
  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    else if (gesture.current) gesture.current.pinchDist = undefined;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!m) return;
    apply({ ...tRef.current, zoom: tRef.current.zoom * Math.exp(-e.deltaY / 400) });
  };

  const d = m ? mediaRect(rect, m.w, m.h, slot.t) : null;
  const mediaStyle: React.CSSProperties | undefined = d
    ? { left: (d.x - rect.x) * s, top: (d.y - rect.y) * s, width: d.w * s, height: d.h * s }
    : undefined;

  return (
    <div
      className={`slot${selected ? ' selected' : ''}${m ? '' : ' empty'}`}
      style={{ left: rect.x * s, top: rect.y * s, width: rect.w * s, height: rect.h * s, borderRadius: radius * s }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={onWheel}
    >
      {m?.kind === 'image' && <img src={m.url} style={mediaStyle} draggable={false} alt="" />}
      {m?.kind === 'video' && <video src={m.url} style={mediaStyle} autoPlay loop muted playsInline />}
      {!m && (
        <div className="placeholder">
          <span className="plus">+</span>
          <span>{index + 1}</span>
        </div>
      )}
      {m?.kind === 'video' && <span className="badge">{m.duration.toFixed(1)}s</span>}
      {m && selected && (
        <div className="slot-actions" onPointerDown={(e) => e.stopPropagation()}>
          {onUp && (
            <button aria-label="Move up" onClick={onUp}>
              <Icon d={ICON_UP} />
            </button>
          )}
          {onDown && (
            <button aria-label="Move down" onClick={onDown}>
              <Icon d={ICON_DOWN} />
            </button>
          )}
          <button aria-label="Remove" className="danger" onClick={onRemove}>
            <Icon d={ICON_TRASH} />
          </button>
        </div>
      )}
    </div>
  );
}
