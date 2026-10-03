import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Relative base so the same build works on GitHub Pages and as a downloaded file.
export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // Classic (IIFE) workers also start from a page opened via file:// in Chromium.
  worker: { format: 'iife' },
  test: { include: ['test/**/*.test.ts', 'examples/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 300_000 },
});
