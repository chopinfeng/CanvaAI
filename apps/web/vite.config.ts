import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/health': { target: 'http://localhost:3001' },
      '/assets': { target: 'http://localhost:3001' },
      '/kg': { target: 'http://localhost:3001' },
    },
  },
});
