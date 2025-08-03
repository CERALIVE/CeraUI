import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/_/, /\/[^/?]+\.[^/]+$/],
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'favicon-96x96.png'],
      manifest: {
        name: 'CeraUI for BELABOX©',
        short_name: 'CeraUI',
        description: 'A modern UI for BELABOX streaming encoder management and configuration',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'web-app-manifest-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'web-app-manifest-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        categories: ['multimedia', 'utilities'],
      },
      devOptions: {
        enabled: true,
      },
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
