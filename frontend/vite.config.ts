import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Backend (FastAPI) runs on :8000. Proxying keeps images same-origin so Konva can export PNGs.
// API_TARGET overrides the backend URL (e.g. a mock server during isolated testing).
const target = process.env.API_TARGET || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/static': target,
    },
  },
});
