import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { generateUniqueVersion, pwaConfig } from './pwa.config';

const VERSION = generateUniqueVersion();

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    tailwindcss(),
    svelte({
      compilerOptions: {
        hmr: mode !== 'production',
      },
      inspector: { showToggleButton: 'always', toggleButtonPos: 'bottom-right' },
    }),
    VitePWA(pwaConfig),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
  },
  publicDir: './src/assets',
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $main: path.resolve('./src/main'),
    },
  },
  server: {
    port: 6173,
  },
}));
