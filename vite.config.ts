import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
})();
const build = { version: pkg.version as string, commit, built: new Date().toISOString() };

/** version.json next to the page: the running app compares itself against it to offer a reload. */
const versionFile = (): Plugin => ({
  name: 'version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build) });
  },
});

// Relative base so the same build works on GitHub Pages and as a downloaded file.
export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile(), versionFile()],
  define: { __APP_BUILD__: JSON.stringify(build) },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // Classic (IIFE) workers also start from a page opened via file:// in Chromium.
  worker: { format: 'iife' },
  test: { include: ['test/**/*.test.ts', 'examples/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 300_000 },
});
