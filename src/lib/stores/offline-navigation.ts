import { derived, writable } from 'svelte/store';

import { isOnline } from './pwa';
import { socket } from './websocket-store';

// Create a connection state store based on actual socket
const connectionState = writable<'connected' | 'connecting' | 'disconnected' | 'error'>('connecting');

// Monitor socket state with event listeners (more efficient than polling)
const updateConnectionState = () => {
  if (socket.readyState === WebSocket.OPEN) {
    connectionState.set('connected');
  } else if (socket.readyState === WebSocket.CONNECTING) {
    connectionState.set('connecting');
  } else if (socket.readyState === WebSocket.CLOSING) {
    connectionState.set('disconnected'); // Treat closing as disconnected for UI purposes
  } else {
    connectionState.set('disconnected');
  }
};

// Handle specific error events to set proper error state
const handleSocketError = () => {
  connectionState.set('error');
};

// Set initial state and add event listeners for efficient monitoring
updateConnectionState();
socket.addEventListener('open', updateConnectionState);
socket.addEventListener('close', updateConnectionState);
socket.addEventListener('error', handleSocketError);

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

// Cleanup function to prevent memory leaks (call in onDestroy lifecycle)
export function cleanup() {
  socket.removeEventListener('open', updateConnectionState);
  socket.removeEventListener('close', updateConnectionState);
  socket.removeEventListener('error', handleSocketError);

  // Also cleanup any pending timeouts
  if (offlineTimeout) {
    clearTimeout(offlineTimeout);
    offlineTimeout = null;
  }
}
