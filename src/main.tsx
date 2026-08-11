import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

import { store } from './store';
import { calcEngine } from './calc/calcEngine';
import { DEFAULT_RUNNER } from './calc/runners';
import { App } from './App';
import './styles.css';

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * Composition root for the calculation.
 *
 * The runner is injected here, and this line is the entire cost of switching
 * execution strategies. The engine, the kernel and every component are unaware
 * of which one is in play — the kernel in particular runs identically here and
 * on the server, where nothing yields at all.
 */
calcEngine.attach(store, DEFAULT_RUNNER.factory);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
