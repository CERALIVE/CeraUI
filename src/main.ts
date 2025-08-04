import './app.css';

import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';

import App from './App.svelte';
import { checkFrontendVersionChange } from './lib/stores/frontend-version';

// Register Service Worker (only frontend update mechanism)
const updateSW = registerSW({
  onNeedRefresh() {
    // Show update available notification for frontend builds
    console.log('🚀 New frontend build available - PWA update needed');

    // Import toast dynamically to avoid circular dependencies
    void import('svelte-sonner').then(({ toast }) => {
      toast.info('Update Available', {
        description: 'A new frontend version is available. Refresh to update.',
        duration: 0, // Persistent
        action: {
          label: 'Refresh',
          onClick: () => {
            console.log('🔄 User refreshing to new frontend build');
            updateSW(true);
          },
        },
      });
    });
  },
  onOfflineReady() {
    console.log('App ready to work offline');

    // Import toast dynamically
    void import('svelte-sonner').then(({ toast }) => {
      toast.success('Offline Ready', {
        description: 'App is ready to work offline!',
        duration: 3000,
      });
    });
  },
  onRegisterError(error) {
    console.error('SW registration error', error);
  },
});

const app = mount(App, { target: document.getElementById('app') as Element });

// Secondary frontend version checking (backup to PWA service worker)
// This runs after app mount to ensure stores are initialized
setTimeout(() => {
  checkFrontendVersionChange();
}, 1000);

export default app;
