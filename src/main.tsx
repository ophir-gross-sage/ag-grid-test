import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

import { store } from './store';
import { calcEngine } from './calc/calcEngine';
import { createSyncRunner } from './calc/runners/syncRunner';
import { App } from './App';
import './styles.css';

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * Composition root for the calculation.
 *
 * The runner is injected here, and this line is the entire cost of switching
 * strategies — worker, time-sliced, viewport-first — once one is chosen. The
 * engine, the kernel and every component are unaware of which one is in play.
 */
calcEngine.attach(store, createSyncRunner);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
