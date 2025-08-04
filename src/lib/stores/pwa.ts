import { writable } from 'svelte/store';

// PWA Installation and Offline Status Store

// Install prompt event
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installEventSetup = false;

// iOS Detection
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
const isIOSSafari =
  isIOS && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS|mercury/.test(navigator.userAgent);

// Stores
export const isOnline = writable(navigator.onLine);
export const canInstall = writable(false);
export const isInstalled = writable(false);
export const showIOSInstallPrompt = writable(false);

// PWA Installation Interface
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

// Online/Offline Detection
function updateOnlineStatus() {
  isOnline.set(navigator.onLine);
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// PWA Install Prompt Handling
function setupInstallPrompt() {
  if (installEventSetup) return;
  installEventSetup = true;

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later
    deferredPrompt = e as BeforeInstallPromptEvent;
    // Update UI to notify the user they can install the PWA
    canInstall.set(true);
  });
}

// Initialize the install prompt handling
setupInstallPrompt();

// Check if app is already installed
window.addEventListener('appinstalled', () => {
  // Clear the deferredPrompt so it can be garbage collected
  deferredPrompt = null;
  canInstall.set(false);
  isInstalled.set(true);
  console.log('PWA was installed');
});

// Check if running in standalone mode (already installed)
if (window.matchMedia('(display-mode: standalone)').matches) {
  isInstalled.set(true);
}

// iOS PWA Installation Detection
function checkIOSInstallability() {
  if (isIOSSafari) {
    // Check if not in standalone mode and not already installed
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone;
    if (!isStandalone) {
      showIOSInstallPrompt.set(true);
    }
  }
}

// Initialize iOS check
checkIOSInstallability();

// Install App Function
export async function installApp(): Promise<boolean> {
  if (!deferredPrompt) {
    return false;
  }

  try {
    // Show the install prompt
    await deferredPrompt.prompt();

    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;

    // Clear the saved prompt since it can't be used again
    deferredPrompt = null;
    canInstall.set(false);

    return outcome === 'accepted';
  } catch (error) {
    console.error('Error during app installation:', error);
    // Clear the prompt on error
    deferredPrompt = null;
    canInstall.set(false);
    return false;
  }
}

// Network Status Helper
// Test function to manually check install availability
export function testInstallPrompt() {
  return { canInstall: !!deferredPrompt, hasEvent: !!deferredPrompt };
}

export function getNetworkInfo() {
  // @ts-ignore - navigator.connection is not in all TypeScript definitions
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  if (connection) {
    return {
      effectiveType: connection.effectiveType,
      downlink: connection.downlink,
      rtt: connection.rtt,
      saveData: connection.saveData,
    };
  }

  return null;
}
