import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LivingCity } from '../src';

const params = new URLSearchParams(location.search);

function Demo() {
  const [theme, setTheme] = useState<'light' | 'dark'>((params.get('theme') as 'dark') || 'light');
  const [speed, setSpeed] = useState(Number(params.get('speed') ?? 1));
  const [density, setDensity] = useState(Number(params.get('density') ?? 1));
  const bare = params.has('bare');
  const dark = theme === 'dark';
  if (bare) {
    return <LivingCity theme={theme} speed={speed} density={density} style={{ height: '100vh' }} />;
  }
  return (
    <div style={{ minHeight: '100vh', background: dark ? '#0e0f12' : '#ffffff', padding: '32px 16px', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', color: dark ? '#d8d9de' : '#2a2b30' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        <LivingCity theme={theme} speed={speed} density={density} style={{ borderRadius: 28 }} />
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', marginTop: 20, fontSize: 14 }}>
          <button onClick={() => setTheme(dark ? 'light' : 'dark')} style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            {dark ? 'Light' : 'Dark'}
          </button>
          <label>
            Speed {speed.toFixed(1)}×{' '}
            <input type="range" min={0.25} max={3} step={0.25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </label>
          <label>
            Density {density.toFixed(1)}{' '}
            <input type="range" min={0.3} max={1.5} step={0.1} value={density} onChange={(e) => setDensity(Number(e.target.value))} />
          </label>
        </div>
      </div>
    </div>
  );
}

if (params.has('debug')) {
  import('../src/engine/scene').then(({ Scene }) => {
    const c = document.createElement('canvas');
    c.style.width = '1600px';
    c.style.height = '860px';
    document.getElementById('root')!.appendChild(c);
    const s = new Scene(c, { speed: Number(params.get('speed') ?? 1) });
    s.resize(1600, 860);
    (window as unknown as { scene: unknown }).scene = s;
  });
} else if (params.has('gallery')) {
  import('./gallery').then((m) => m.gallery(document.getElementById('root')!));
} else createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
