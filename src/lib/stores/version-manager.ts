import { get, writable } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

// Get client version from build-time injection
declare const __APP_VERSION__: string;
export const CLIENT_VERSION = __APP_VERSION__;

// Development mode detection
const isDevelopment = import.meta.env.DEV || CLIENT_VERSION.includes('dev-build');

// Log frontend version info (debug mode only)
if (!import.meta.env.PROD) {
  console.log('🚀 Frontend version initialized:', {
    version: CLIENT_VERSION,
    updateMethod: 'PWA Service Worker only',
    isDevelopment,
  });
}

// Stores for version management
export const clientVersion = writable<string>(CLIENT_VERSION);
export const serverVersion = writable<string | null>(null);
export const versionMismatch = writable<boolean>(false);

// Track if we've already triggered an update to avoid spam
let updateTriggered = false;

/**
 * Parse version string to extract commit hash and build ID
 */
function parseVersion(version: string): { commit: string; buildId: string; full: string } {
  const parts = version.split('-');
  if (parts.length >= 2) {
    return {
      commit: parts[0],
      buildId: parts.slice(1).join('-'), // Handle cases where there might be multiple dashes
      full: version,
    };
  }
  return {
    commit: version,
    buildId: '',
    full: version,
  };
}

/**
 * Compare client and server versions
 * Returns true if versions are different
 */
export function compareVersions(client: string, server: string): boolean {
  const clientParsed = parseVersion(client);

  // Clean server version (remove newlines and extra text)
  const cleanServer = server.replace(/\n.*$/, '').trim();
  const serverParsed = parseVersion(cleanServer);

  // Only compare commit hashes, ignore build IDs
  const commitsDifferent = clientParsed.commit !== serverParsed.commit;

  // Log detailed comparison for debugging
  console.log('🔍 Version comparison (commit-only):', {
    clientRaw: client,
    serverRaw: server,
    serverCleaned: cleanServer,
    clientCommit: clientParsed.commit,
    serverCommit: serverParsed.commit,
    commitsDifferent,
    willUpdate: commitsDifferent,
  });

  // Only trigger update if commit hashes are different (ignore build IDs)
  return commitsDifferent;
}

/**
 * Handle version comparison and trigger updates if needed
 */
export function checkVersionMismatch(newServerVersion: string) {
  const currentClientVersion = get(clientVersion);

  // Skip version checking in development mode
  if (isDevelopment) {
    console.log('🔧 Skipping version check in development mode:', {
      client: currentClientVersion,
      server: newServerVersion,
      isDev: isDevelopment,
      envDev: import.meta.env.DEV,
      includesDevBuild: CLIENT_VERSION.includes('dev-build'),
    });
    return;
  }

  console.log('✅ Version checking enabled (production mode):', {
    client: currentClientVersion,
    server: newServerVersion,
    isDevelopment,
    updateTriggered,
  });

  // Always log version info for debugging
  console.log('🔍 Version check:', {
    client: currentClientVersion,
    server: newServerVersion,
    updateTriggered,
    isDevelopment,
  });

  // Update server version store
  serverVersion.set(newServerVersion);

  // Check for mismatch
  const hasMismatch = compareVersions(currentClientVersion, newServerVersion);
  versionMismatch.set(hasMismatch);

  console.log('📊 Version comparison result:', {
    hasMismatch,
    updateTriggered,
    clientParsed: parseVersion(currentClientVersion),
    serverParsed: parseVersion(newServerVersion),
  });

  if (hasMismatch && !updateTriggered) {
    updateTriggered = true;

    const clientParsed = parseVersion(currentClientVersion);
    const serverParsed = parseVersion(newServerVersion);

    console.log(`🚨 Version mismatch detected:
      Client: ${currentClientVersion} (commit: ${clientParsed.commit}, build: ${clientParsed.buildId})
      Server: ${newServerVersion} (commit: ${serverParsed.commit}, build: ${serverParsed.buildId})`);

    // Trigger PWA update
    triggerPWAUpdate(clientParsed, serverParsed);
  } else if (hasMismatch && updateTriggered) {
    console.log('⚠️ Version mismatch detected but update already triggered');
  } else if (!hasMismatch) {
    console.log('✅ Versions match - no update needed');
  }
}

/**
 * Trigger PWA update with user notification
 */
function triggerPWAUpdate(
  clientVersion: { commit: string; buildId: string; full: string },
  serverVersion: { commit: string; buildId: string; full: string },
) {
  // Determine what changed
  const commitChanged = clientVersion.commit !== serverVersion.commit;
  const buildChanged = clientVersion.buildId !== serverVersion.buildId;

  // Get translated update reason
  let updateReasonKey = '';
  if (commitChanged && buildChanged) {
    updateReasonKey = 'version.newCodeAndBuild';
  } else if (commitChanged) {
    updateReasonKey = 'version.newCodeVersion';
  } else if (buildChanged) {
    updateReasonKey = 'version.newBuildVersion';
  } else {
    updateReasonKey = 'version.serverUpdated';
  }

  const updateReason = get(_)(updateReasonKey);
  const refreshMessage = get(_)('version.refreshToUpdate');
  const title = get(_)('version.newVersionAvailable');
  const refreshLabel = get(_)('version.refreshNow');

  console.log('🔔 Showing version update notification:', {
    title,
    updateReason,
    refreshMessage,
  });

  toast.info(title, {
    description: `${updateReason}. ${refreshMessage}.`,
    duration: 0, // Persistent
    action: {
      label: refreshLabel,
      onClick: () => {
        console.log('🔄 User clicked refresh - reloading page');
        window.location.reload();
      },
    },
    onDismiss: () => {
      // Reset trigger flag if user dismisses
      console.log('❌ User dismissed version update notification - resetting trigger');
      updateTriggered = false;
    },
  });
}

/**
 * Reset update trigger flag (useful for testing)
 */
export function resetUpdateTrigger() {
  console.log('🔄 Manually resetting update trigger flag');
  updateTriggered = false;
}

/**
 * Force a version check (for debugging)
 */
export function forceVersionCheck(serverVersion: string) {
  console.log('🔧 Force version check triggered');
  resetUpdateTrigger();
  checkVersionMismatch(serverVersion);
}

/**
 * Get current version status for debugging
 */
export function getVersionStatus() {
  const client = get(clientVersion);
  const server = get(serverVersion);

  return {
    client: client ? parseVersion(client) : null,
    server: server ? parseVersion(server) : null,
    mismatch: get(versionMismatch),
    updateTriggered,
    isDevelopment,
    raw: {
      client,
      server,
    },
  };
}
