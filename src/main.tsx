import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// iOS Home Screen apps report a viewport shorter than the screen, which leaves an empty band at the bottom.
// In standalone mode, size the app to the physical screen instead.
const standalone =
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
if (standalone) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${window.screen.height}px`);
  fit();
  window.addEventListener('resize', fit);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
