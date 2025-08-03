import { derived, writable } from 'svelte/store';

import { isOnline } from './pwa';
import { connectionState } from './websocket-enhanced';

// Store to track if we should show the offline page
export const shouldShowOfflinePage = writable(false);

// Store to track offline state combining browser + WebSocket states
export const isFullyOffline = derived([isOnline, connectionState], ([$isOnline, $connectionState]) => {
  // Consider offline if:
  // 1. Browser is offline, OR
  // 2. WebSocket is disconnected/error for extended period
  return !$isOnline || $connectionState === 'disconnected' || $connectionState === 'error';
});

// Enhanced offline detection with persistence
let offlineStartTime: number | null = null;
let offlineTimeout: number | null = null;
const OFFLINE_THRESHOLD = 10000; // Show offline page after 10 seconds of being disconnected

// Subscribe to offline state changes
isFullyOffline.subscribe(offline => {
  if (offline) {
    if (offlineStartTime === null) {
      offlineStartTime = Date.now();

      // Set timeout to show offline page if still offline after threshold
      offlineTimeout = window.setTimeout(() => {
        shouldShowOfflinePage.set(true);
      }, OFFLINE_THRESHOLD);
    }
  } else {
    // Back online - clear timers and hide offline page
    if (offlineTimeout) {
      clearTimeout(offlineTimeout);
      offlineTimeout = null;
    }
    offlineStartTime = null;
    shouldShowOfflinePage.set(false);
  }
});

// Manual control functions
export function showOfflinePage() {
  shouldShowOfflinePage.set(true);
}

export function hideOfflinePage() {
  shouldShowOfflinePage.set(false);
}

// Reset offline detection (useful for manual reconnection attempts)
export function resetOfflineDetection() {
  if (offlineTimeout) {
    clearTimeout(offlineTimeout);
    offlineTimeout = null;
  }
  offlineStartTime = null;
  shouldShowOfflinePage.set(false);
}
