import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// iOS 26 Home Screen apps can't draw in the strip above the home indicator; iOS fills it with the page
// background. Mark standalone mode so CSS can drop the now-redundant bottom safe-area spacing.
const standalone =
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
if (standalone) document.documentElement.dataset.standalone = '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
