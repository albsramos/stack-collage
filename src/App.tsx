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
import { exportCollage, hasVideo, saveResult, type ExportResult, type SlotState } from './exporter';

type Step = 'template' | 'format' | 'editor';

const MAX_DURATION = 60;

const emptySlots = (): SlotState[] => [0, 1, 2].map(() => ({ media: null, t: { ...IDENTITY } }));

export default function App() {
  const [step, setStep] = useState<Step>('template');
  const [count, setCount] = useState<Count>(3);
  const [formatId, setFormatId] = useState<FormatId>('story');
  const [layout, setLayout] = useState<LayoutOpts>(defaultLayout(3, 'story'));
  const bg = '#000000'; // never visible: slots always fill the frame
  const [slots, setSlots] = useState<SlotState[]>(emptySlots);
  const [scale, setScale] = useState<1 | 2>(1);
  const [audioFrom, setAudioFrom] = useState<number | 'auto' | null>('auto');
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ progress: number; label: string } | null>(null);
  const [result, setResult] = useState<(ExportResult & { url: string }) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const format = FORMATS[formatId];
  const active = slots.slice(0, count);
  const anyVideo = hasVideo(active);
  const filled = active.every((s) => s.media);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

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
    setBusy({ progress: -1, label: 'Opening…' });
    for (let j = 0; j < list.length; j++) {
      try {
        const m = await loadMedia(list[j]);
        const idx = indices[j];
        setSlots((prev) => {
          const next = [...prev];
          releaseMedia(next[idx].media);
          next[idx] = { media: m, t: { ...IDENTITY } };
          return next;
        });
      } catch (e) {
        showToast((e as Error).message);
      }
    }
    setBusy(null);
  };

  // ---------- slot ops ----------
  const setT = (i: number, t: Transform) =>
    setSlots((prev) => prev.map((s, k) => (k === i ? { ...s, t } : s)));

  const removeSlot = (i: number) => {
    setSlots((prev) => {
      const next = [...prev];
      releaseMedia(next[i].media);
      next[i] = { media: null, t: { ...IDENTITY } };
      return next;
    });
    setSelected(null);
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
  const chooseTemplate = (c: Count) => {
    setCount(c);
    setStep('format');
  };
  const chooseFormat = (f: FormatId) => {
    setFormatId(f);
    setLayout(defaultLayout(count, f));
    setStep('editor');
  };
  const startOver = () => {
    slots.forEach((s) => releaseMedia(s.media));
    setSlots(emptySlots());
    setSelected(null);
    setStep('template');
  };

  const resolvedAudio = useMemo(() => {
    if (audioFrom === 'auto') {
      const i = active.findIndex((s) => s.media?.kind === 'video' && s.media.hasAudio);
      return i >= 0 ? i : null;
    }
    if (audioFrom === null) return null;
    return active[audioFrom]?.media?.kind === 'video' ? audioFrom : null;
  }, [audioFrom, active]);

  const doExport = async () => {
    setSelected(null);
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy({ progress: 0, label: anyVideo ? 'Rendering video…' : 'Rendering…' });
    try {
      const r = await exportCollage({
        format,
        layout,
        slots: active,
        background: bg,
        scale,
        audioFrom: resolvedAudio,
        maxDuration: MAX_DURATION,
        signal: ac.signal,
        onProgress: (p) => setBusy((b) => (b ? { ...b, progress: p } : b)),
      });
      setResult({ ...r, url: URL.createObjectURL(r.blob) });
      if (r.warning) showToast(r.warning);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') {
        console.error(e);
        showToast(`Export failed: ${(e as Error).message}`);
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const closeResult = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
  };

  // ---------- screens ----------
  if (step === 'template') {
    return (
      <div className="screen start">
        <main className="options">
          {([2, 3] as Count[]).map((c) => (
            <button key={c} className="option" onClick={() => chooseTemplate(c)} aria-label={`${c} stacked`}>
              <MiniLayout count={c} formatId="story" />
            </button>
          ))}
        </main>
      </div>
    );
  }

  if (step === 'format') {
    return (
      <div className="screen start">
        <main className="options">
          {(Object.keys(FORMATS) as FormatId[]).map((f) => (
            <button key={f} className="option" onClick={() => chooseFormat(f)} aria-label={FORMATS[f].label}>
              <MiniLayout count={count} formatId={f} />
              <span className="option-label">{FORMATS[f].label}</span>
            </button>
          ))}
        </main>
        <button className="back-btn" onClick={() => setStep('template')}>
          Back
        </button>
      </div>
    );
  }

  const sel = selected !== null ? slots[selected] : null;

  return (
    <div className="screen editor">
      <div className="topbar">
        <button className="icon" onClick={startOver} aria-label="Start over">
          ‹
        </button>
        <span className="title">
          {FORMATS[formatId].label} <small>{FORMATS[formatId].sub}</small>
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
              <button onClick={() => moveSlot(selected, -1)} disabled={selected === 0}>
                ↑
              </button>
              <button onClick={() => moveSlot(selected, 1)} disabled={selected === count - 1}>
                ↓
              </button>
              <button className="danger" onClick={() => removeSlot(selected)}>
                Remove
              </button>
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
            <div className="row">
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
              <div className="row">
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
                        onClick={() => setAudioFrom(i)}
                      >
                        Video {i + 1}
                      </button>
                    ) : null,
                  )}
                </div>
              </div>
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
            <button className="primary wide" onClick={() => saveResult(result).catch((e) => showToast((e as Error).message))}>
              Save
            </button>
            <button className="wide" onClick={closeResult}>
              Back to editing
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
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
}

function Stage(p: StageProps) {
  const f = FORMATS[p.formatId];
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
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
}

function SlotView({ index, rect, s, radius, slot, selected, onTap, onTransform, onGestureStart }: SlotViewProps) {
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
      onPointerCancel={onPointerUp}
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
    </div>
  );
}
