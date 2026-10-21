import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  optimizeDeps: {
    exclude: ['@luxalgo/vela', '@luxalgo/vela-pinets', 'pinets'],
  },
});
