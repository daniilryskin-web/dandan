import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './state/store';
import { input, runtime, useWorld } from './state/world';

if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { __liga: unknown }).__liga = { runtime, input, useStore, useWorld };
}
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
