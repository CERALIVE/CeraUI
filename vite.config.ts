import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';
import { defineConfig } from 'vite';

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
  ],
  publicDir: './src/assets',
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $main: path.resolve('./src/main'),
    },
  },
}));
