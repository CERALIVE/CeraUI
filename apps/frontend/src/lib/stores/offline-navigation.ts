import { derived, writable } from 'svelte/store';

import { isOnline } from './pwa';
import { socket } from './websocket-store';

// Create a connection state store based on actual socket
const connectionState = writable<'connected' | 'connecting' | 'disconnected' | 'error'>(
  'connecting'
);

// Monitor socket state with event listeners (more efficient than polling)
const updateConnectionState = () => {
  if (!socket) {
    connectionState.set('disconnected');
    return;
  }

  if (socket.readyState === WebSocket.OPEN) {
    connectionState.set('connected');
  } else if (socket.readyState === WebSocket.CONNECTING) {
    connectionState.set('connecting');
  } else {
    connectionState.set('disconnected'); // CLOSING, CLOSED, or any other state
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
export const isFullyOffline = derived(
  [isOnline, connectionState],
  ([$isOnline, $connectionState]) => {
    // Consider offline if:
    // 1. Browser is offline, OR
    // 2. WebSocket is disconnected/error for extended period
    return !$isOnline || $connectionState === 'disconnected' || $connectionState === 'error';
  }
);

// Enhanced offline detection with persistence
let offlineStartTime: number | null = null;
let offlineTimeout: number | null = null;
let periodicCheckInterval: number | null = null;
const OFFLINE_THRESHOLD = 3000; // Show offline page after 3 seconds (reduced for better UX)
const PERIODIC_CHECK_INTERVAL = 5000; // Check connection every 5 seconds when offline

// Function to check if we can establish connection
async function checkConnection(isInitialCheck = false): Promise<boolean> {
  try {
    // For initial check, use a very short timeout and simpler approach
    if (isInitialCheck) {
      // Try multiple approaches for iOS compatibility
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 500); // Very short timeout

      try {
        // Try a simple fetch without no-cors first (works better on iOS)
        await fetch(window.location.origin + '/favicon.ico', {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-cache',
        });
        clearTimeout(timeoutId);
        return true;
      } catch {
        // If that fails, try the original approach
        clearTimeout(timeoutId);
        const timeoutId2 = setTimeout(() => controller.abort(), 300);
        await fetch(window.location.origin + '/', {
          method: 'HEAD',
          mode: 'no-cors',
          signal: controller.signal,
          cache: 'no-cache',
        });
        clearTimeout(timeoutId2);
        return true;
      }
    } else {
      // Regular check for periodic monitoring
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      await fetch(window.location.origin + '/', {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
        cache: 'no-cache',
      });

      clearTimeout(timeoutId);
      return true;
    }
  } catch {
    // If fetch fails, we're likely offline
    return false;
  }
}

// Start periodic connection checking when offline
function startPeriodicConnectionCheck() {
  if (periodicCheckInterval) {
    clearInterval(periodicCheckInterval);
  }

  periodicCheckInterval = window.setInterval(async () => {
    const canConnect = await checkConnection();
    if (canConnect) {
      // Connection is back! Reset offline state immediately
      shouldShowOfflinePage.set(false);
      stopPeriodicConnectionCheck();
      offlineStartTime = null;

      // Check if we're in PWA mode for appropriate reconnection
      const isPWA =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone ||
        document.referrer.includes('android-app://');

      if (isPWA) {
        // For PWA, reload immediately to ensure proper reconnection
        window.location.reload();
      } else {
        // For browser, check WebSocket state first
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          // Trigger page reload to re-establish full connection
          window.location.reload();
        }
      }
    }
  }, PERIODIC_CHECK_INTERVAL);
}

// Stop periodic connection checking
function stopPeriodicConnectionCheck() {
  if (periodicCheckInterval) {
    clearInterval(periodicCheckInterval);
    periodicCheckInterval = null;
  }
}

// Check if we're offline immediately on startup
let hasCheckedInitialState = false;

// Simplified startup connectivity check
function checkInitialConnectivity() {
  // Check browser offline state immediately
  if (!navigator.onLine) {
    shouldShowOfflinePage.set(true);
    startPeriodicConnectionCheck();
    offlineStartTime = Date.now();
    hasCheckedInitialState = true;
    return;
  }

  // For PWA or when potentially offline, do a quick connection test
  setTimeout(async () => {
    try {
      const canConnect = await checkConnection(true);
      if (!canConnect) {
        shouldShowOfflinePage.set(true);
        startPeriodicConnectionCheck();
        offlineStartTime = Date.now();
      }
    } catch {
      shouldShowOfflinePage.set(true);
      startPeriodicConnectionCheck();
      offlineStartTime = Date.now();
    }
    hasCheckedInitialState = true;
  }, 200);
}

// Add browser offline/online event listeners (very reliable on iOS)
const handleOffline = () => {
  shouldShowOfflinePage.set(true);
  startPeriodicConnectionCheck();
  offlineStartTime = Date.now();
};

const handleOnline = () => {
  // When browser says we're online, do a quick connectivity test
  setTimeout(async () => {
    const canConnect = await checkConnection();
    if (canConnect) {
      shouldShowOfflinePage.set(false);
      stopPeriodicConnectionCheck();
      offlineStartTime = null;
    }
    // If we can't connect despite browser saying online, keep showing offline page
  }, 500);
};

// Listen for browser offline/online events
window.addEventListener('offline', handleOffline);
window.addEventListener('online', handleOnline);

// Run initial check
checkInitialConnectivity();

// Subscribe to offline state changes
isFullyOffline.subscribe(async (offline) => {
  if (offline) {
    if (offlineStartTime === null) {
      offlineStartTime = Date.now();

      // Skip timeout if we haven't done initial check yet (immediate check will handle it)
      // Or use shorter timeout for subsequent disconnections
      const threshold = hasCheckedInitialState ? OFFLINE_THRESHOLD : 0;

      if (threshold > 0) {
        // Set timeout to show offline page if still offline after threshold
        offlineTimeout = window.setTimeout(() => {
          shouldShowOfflinePage.set(true);
          // Start checking for reconnection periodically
          startPeriodicConnectionCheck();
        }, threshold);
      }
      // If threshold is 0, the initial connectivity check will handle showing offline page
    }
  } else {
    // Back online - clear timers and hide offline page
    if (offlineTimeout) {
      clearTimeout(offlineTimeout);
      offlineTimeout = null;
    }
    stopPeriodicConnectionCheck();
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
  stopPeriodicConnectionCheck();
  offlineStartTime = null;
  shouldShowOfflinePage.set(false);
}

// Export connection checking function for manual retry
export { checkConnection };

// Force check connection and handle result
export async function manualConnectionCheck(): Promise<boolean> {
  const canConnect = await checkConnection();
  if (canConnect) {
    // Connection is back! Reset offline state and allow normal flow
    resetOfflineDetection();

    // Check if we're in PWA mode
    const isPWA =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone ||
      document.referrer.includes('android-app://');

    if (isPWA) {
      // For PWA, force a full reload to ensure proper reconnection
      setTimeout(() => {
        window.location.reload();
      }, 300);
    } else {
      // For browser, just reload normally
      setTimeout(() => {
        window.location.reload();
      }, 500);
    }
    return true;
  }
  return false;
}

// Cleanup function to prevent memory leaks (call in onDestroy lifecycle)
export function cleanup() {
  socket.removeEventListener('open', updateConnectionState);
  socket.removeEventListener('close', updateConnectionState);
  socket.removeEventListener('error', handleSocketError);

  // Remove browser offline/online event listeners
  window.removeEventListener('offline', handleOffline);
  window.removeEventListener('online', handleOnline);

  // Also cleanup any pending timeouts and intervals
  if (offlineTimeout) {
    clearTimeout(offlineTimeout);
    offlineTimeout = null;
  }
  stopPeriodicConnectionCheck();
}
