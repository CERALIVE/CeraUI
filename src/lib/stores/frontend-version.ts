import { writable } from 'svelte/store';
import { toast } from 'svelte-sonner';

import { CLIENT_VERSION } from './version-manager';

// Store for tracking frontend version changes
export const frontendVersion = writable<string>(CLIENT_VERSION);
export const hasVersionChanged = writable<boolean>(false);

const FRONTEND_VERSION_KEY = 'ceraui_frontend_version';

/**
 * Check if frontend version has changed since last visit
 * This works as a secondary detection mechanism alongside PWA service worker
 */
export function checkFrontendVersionChange(): boolean {
  const currentVersion = CLIENT_VERSION;
  const storedVersion = localStorage.getItem(FRONTEND_VERSION_KEY);

  console.log('🔍 Frontend version check:', {
    current: currentVersion,
    stored: storedVersion,
    isFirstVisit: !storedVersion,
    hasChanged: storedVersion && storedVersion !== currentVersion,
  });

  // First visit - just store the version
  if (!storedVersion) {
    localStorage.setItem(FRONTEND_VERSION_KEY, currentVersion);
    console.log('📝 First visit - storing frontend version:', currentVersion);
    return false;
  }

  // Check if version changed
  const versionChanged = storedVersion !== currentVersion;
  hasVersionChanged.set(versionChanged);

  if (versionChanged) {
    console.log('🔄 Frontend version changed:', {
      from: storedVersion,
      to: currentVersion,
    });

    // Update stored version immediately to prevent repeated notifications
    localStorage.setItem(FRONTEND_VERSION_KEY, currentVersion);

    // Show secondary update notification
    showVersionChangeNotification(storedVersion, currentVersion);
    return true;
  }

  console.log('✅ Frontend version unchanged');
  return false;
}

/**
 * Show version change notification (secondary to PWA updates)
 */
function showVersionChangeNotification(oldVersion: string, newVersion: string) {
  console.log('🔔 Showing secondary version change notification');

  // Parse versions to understand what changed
  const oldParts = oldVersion.split('-');
  const newParts = newVersion.split('-');

  const commitChanged = oldParts[0] !== newParts[0];
  const buildChanged = oldParts[1] !== newParts[1];

  let changeType = 'Updated';
  if (commitChanged && buildChanged) {
    changeType = 'New code and build';
  } else if (commitChanged) {
    changeType = 'New code version';
  } else if (buildChanged) {
    changeType = 'New build';
  }

  toast.info('Frontend Updated', {
    description: `${changeType} detected. Consider refreshing for the latest features.`,
    duration: 8000,
    action: {
      label: 'Refresh',
      onClick: () => {
        console.log('🔄 User refreshing from secondary version notification');
        window.location.reload();
      },
    },
  });
}

/**
 * Reset version tracking (useful for testing)
 */
export function resetFrontendVersionTracking() {
  localStorage.removeItem(FRONTEND_VERSION_KEY);
  hasVersionChanged.set(false);
  console.log('🗑️ Frontend version tracking reset');
}

/**
 * Get version info for debugging
 */
export function getFrontendVersionInfo() {
  return {
    current: CLIENT_VERSION,
    stored: localStorage.getItem(FRONTEND_VERSION_KEY),
    hasChanged: hasVersionChanged,
  };
}

/**
 * Force version change notification (for testing)
 */
export function forceVersionChangeNotification() {
  const storedVersion = localStorage.getItem(FRONTEND_VERSION_KEY) || 'test-old-version';
  showVersionChangeNotification(storedVersion, CLIENT_VERSION);
}
