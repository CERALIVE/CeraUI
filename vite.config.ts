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
        // Enhanced debugging options for Svelte 5
        dev: mode !== 'production',
      },
      inspector: { 
        showToggleButton: 'always', 
        toggleButtonPos: 'bottom-right',
        // Enhanced inspector settings for better debugging
        holdMode: true,
      },
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
  // Enhanced development server configuration
  server: {
    port: 6173,
    // Configure source map ignore list for better debugging
    sourcemapIgnoreList(sourcePath) {
      return sourcePath.includes('node_modules') && !sourcePath.includes('@sveltejs');
    },
  },
  // Enhanced CSS development source maps (experimental feature)
  css: {
    devSourcemap: true,
  },
  // Development-specific optimizations
  ...(mode !== 'production' && {
    // Enable inline source maps for better debugging in development
    build: {
      sourcemap: 'inline',
    },
    // Enhanced dependency optimization for debugging
    optimizeDeps: {
      include: [
        // Pre-bundle these for consistent debugging experience
        // Add any frequently used dependencies here
      ],
      exclude: [
        // Keep these as separate modules for better debugging
        '@sveltejs/vite-plugin-svelte',
      ],
    },
  }),
}));
