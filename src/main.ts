import './app.css';

import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';

import App from './App.svelte';

// Register Service Worker
const updateSW = registerSW({
  onNeedRefresh() {
    // Show update available notification
    console.log('New content available, please refresh.');

    // Import toast dynamically to avoid circular dependencies
    void import('svelte-sonner').then(({ toast }) => {
      toast.info('Update Available', {
        description: 'A new version is available. Refresh to update.',
        duration: 0, // Persistent
        action: {
          label: 'Refresh',
          onClick: () => updateSW(true),
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

export default app;
