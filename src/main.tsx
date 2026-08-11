import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

import { store } from './store';
import { App } from './App';
import './styles.css';

ModuleRegistry.registerModules([AllCommunityModule]);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
