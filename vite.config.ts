import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';
import { defineConfig } from 'vite';

const fullReloadAlways = {
  name: 'full-reload',
  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleHotUpdate({ server }: { server: any }) {
    server.ws.send({ type: 'full-reload' });
    return [];
  },
};
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte({
      compilerOptions: { hmr: true },
    }),
    fullReloadAlways,
  ],
  publicDir: './src/assets',
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
});
