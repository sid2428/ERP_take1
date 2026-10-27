import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, forward the authenticated finance API to the ERP backend.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/student/fee/api': 'http://localhost:3100' } },
  base: '/static/fee-app/',
  build: {
    outDir: '../../public/fee-app',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
