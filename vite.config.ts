import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // ag-grid is large; keep it in its own chunk so app code stays cheap to re-download.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/ag-grid')) return 'ag-grid';
          if (id.includes('node_modules/@reduxjs') || id.includes('node_modules/react-redux')) {
            return 'redux';
          }
          return undefined;
        },
      },
    },
  },
});
