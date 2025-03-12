<script lang="ts">
import Auth from './Auth.svelte';
import Main from './MainView.svelte';
import { setupLocale } from '../i18n';
import { toast } from 'svelte-sonner';
import type { NotificationType, StatusMessage } from '$lib/types/socket-messages';
import { Toaster } from '$lib/components/ui/sonner';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';
import { authStatusStore } from '$lib/stores/auth-status';
import { AuthMessages, NotificationsMessages, StatusMessages, sendAuthMessage } from '$lib/stores/websocket-store';
import { startStreaming as startStreamingFn, stopStreaming as stopStreamingFn } from '$lib/helpers/SystemHelper';

let authStatus = $state(false);
let isCheckingAuthStatus = $state(true);
let updatingStatus: StatusMessage['updating'] = $state(false);
const setupLocaleResult = setupLocale();

// Toast tracking system for duplicates
interface ToastInfo {
  id: string;
  timestamp: number;
  duration: number;
  notificationKey: string; // Unique key for identifying similar notifications
}
let activeToasts = $state<Record<string, ToastInfo>>({});
// Simple flag to prevent recursive updates
let isUpdatingToasts = false;

// Function to dismiss all non-persistent toasts
const dismissAllNonPersistentToasts = () => {
  // Guard against recursion
  if (isUpdatingToasts) return;
  
  try {
    isUpdatingToasts = true;
    
    // Use Sonner's built-in dismissAll method first which is more reliable
    toast.dismiss();
    
    // Reset tracking state safely
    setTimeout(() => {
      activeToasts = {};
    }, 0);
  } finally {
    isUpdatingToasts = false;
  }
};

// Override original SystemHelper functions to add toast clearing
const startStreaming = (config: { [key: string]: string | number }) => {
  // Guard against infinite updates
  if (isUpdatingToasts) {
    startStreamingFn(config);
    return;
  }
  
  try {
    isUpdatingToasts = true;
    
    // Force clear all toasts completely
    toast.dismiss();
    
    // Clear all persistent notification timers
    Object.values(persistentNotificationTimers).forEach(timer => {
      clearTimeout(timer);
    });
    
    // Reset tracking states safely using setTimeout to avoid reactive updates
    setTimeout(() => {
      activeToasts = {};
      persistentNotificationTimers = {};
    }, 0);
    
    // Now call the original function
    startStreamingFn(config);
  } finally {
    // Ensure flag is reset
    isUpdatingToasts = false;
  }
};

const stopStreaming = () => {
  // Guard against infinite updates
  if (isUpdatingToasts) {
    stopStreamingFn();
    return;
  }
  
  try {
    isUpdatingToasts = true;
    
    // Force clear all toasts completely
    toast.dismiss();
    
    // Clear all persistent notification timers
    Object.values(persistentNotificationTimers).forEach(timer => {
      clearTimeout(timer);
    });
    
    // Reset tracking states safely using setTimeout to avoid reactive updates
    setTimeout(() => {
      activeToasts = {};
      persistentNotificationTimers = {};
    }, 0);
    
    // Now call the original function
    stopStreamingFn();
  } finally {
    // Ensure flag is reset
    isUpdatingToasts = false;
  }
};

// Show a toast, extending duration if a duplicate exists
const showToast = (type: NotificationType, name: string, options: any) => {
  // Prevent recursive calls that could cause infinite loops
  if (isUpdatingToasts) return;
  
  try {
    isUpdatingToasts = true;
    
    // Generate a message-only key to identify toasts with the same content
    const messageKey = options.description;
    const now = Date.now();
    
    // For persistent notifications, don't create duplicates
    if (options.isPersistent) {
      // Check if we already have this persistent notification
      const existingPersistentToastEntries = Object.entries(activeToasts).filter(([_, toast]) => 
        toast.notificationKey === messageKey && toast.duration === Infinity
      );
      
      if (existingPersistentToastEntries.length > 0) {
        // We already have this persistent notification showing
        // The timer has already been reset in the subscription, so just skip creating a duplicate
        return;
      }
    }
    
    // Create a unique ID for this toast
    const id = `toast-${now}-${Math.random().toString(36).substr(2, 9)}`;
    options.id = id;
    
    // Simplified onDismiss handler
    const originalOnDismiss = options.onDismiss;
    options.onDismiss = () => {
      // Call original onDismiss if it exists
      if (originalOnDismiss) originalOnDismiss();
      
      // Safely update our tracking
      if (activeToasts[id]) {
        setTimeout(() => {
          const newActiveToasts = { ...activeToasts };
          delete newActiveToasts[id];
          activeToasts = newActiveToasts;
        }, 0);
      }
    };
    
    // Display the toast
    toast[type](name, options);
    
    // Track this toast
    const toastInfo = {
      id,
      timestamp: now,
      duration: options.duration,
      notificationKey: messageKey
    };
    
    // Use a non-reactive way to update activeToasts to avoid triggering effects
    setTimeout(() => {
      activeToasts = { ...activeToasts, [id]: toastInfo };
    }, 0);
    
    // Clean up the toast tracking after it expires (except for persistent toasts)
    if (options.duration !== Infinity) {
      setTimeout(() => {
        try {
          // Safely dismiss and remove tracking
          toast.dismiss(id);
          
          setTimeout(() => {
            if (activeToasts[id]) {
              const newActiveToasts = { ...activeToasts };
              delete newActiveToasts[id];
              activeToasts = newActiveToasts;
            }
          }, 0);
        } catch (e) {
          console.error('Error cleaning up toast:', e);
        }
      }, options.duration + 1000); // Add 1 second buffer
    }
  } finally {
    // Always make sure we reset the flag
    isUpdatingToasts = false;
  }
};

StatusMessages.subscribe(status => {
  updatingStatus = status?.updating && typeof status.updating !== 'boolean' && status.updating.result !== 0;
});
const auth = localStorage.getItem('auth');
if (auth) {
  sendAuthMessage(auth, true, () => {
    isCheckingAuthStatus = false;
  });
} else {
  isCheckingAuthStatus = false;
}

AuthMessages.subscribe(message => {
  if (message?.success) {
    isCheckingAuthStatus = false;
    showToast('success', 'AUTH', {
      duration: 5000,
      description: 'Successfully authenticated',
      dismissable: true
    });
    authStatusStore.set(true);
  }

  authStatusStore.subscribe(status => {
    authStatus = status;
  });
});

// Time after which we'll automatically clear a persistent notification if no new updates arrive
const PERSISTENT_AUTO_CLEAR_TIMEOUT = 5000; // 5 seconds

// Track timers for auto-clearing persistent notifications
let persistentNotificationTimers = $state<Record<string, number>>({});

NotificationsMessages.subscribe(notifications => {
  notifications?.show?.forEach(notification => {
    const toastKey = `${notification.type}-${notification.msg}`;
    
    // If this is a persistent notification, reset/create its auto-clear timer
    if (notification.is_persistent) {
      // Clear any existing timer for this notification
      if (persistentNotificationTimers[toastKey]) {
        clearTimeout(persistentNotificationTimers[toastKey]);
      }
      
      // Set a new timer to auto-clear this notification if no new updates arrive
      const timerId = window.setTimeout(() => {
        // Find any toasts with this key
        Object.entries(activeToasts).forEach(([id, toast]) => {
          if (toast.notificationKey === notification.msg && toast.duration === Infinity) {
            // Auto-clear this toast since no new updates have arrived
            toast.dismiss(toast.id);
            
            // Update our tracking
            setTimeout(() => {
              const newActiveToasts = { ...activeToasts };
              delete newActiveToasts[id];
              activeToasts = newActiveToasts;
            }, 0);
          }
        });
        
        // Remove this timer from tracking
        setTimeout(() => {
          const newTimers = { ...persistentNotificationTimers };
          delete newTimers[toastKey];
          persistentNotificationTimers = newTimers;
        }, 0);
      }, PERSISTENT_AUTO_CLEAR_TIMEOUT);
      
      // Update the timers object
      const newTimers = { ...persistentNotificationTimers };
      newTimers[toastKey] = timerId;
      persistentNotificationTimers = newTimers;
    }
    
    // Show the toast
    showToast(notification.type as NotificationType, notification.name.toUpperCase(), {
      description: notification.msg,
      duration: notification.is_persistent ? Infinity : notification.duration * 2500,
      dismissable: !notification.is_dismissable,
      isPersistent: notification.is_persistent
    });
  });
});

// TypeScript interface for global window object
declare global {
  interface Window {
    startStreamingWithNotificationClear: typeof startStreaming;
    stopStreamingWithNotificationClear: typeof stopStreaming;
  }
}

// Export our functions to the global scope to make them available to other components
window.startStreamingWithNotificationClear = startStreaming;
window.stopStreamingWithNotificationClear = stopStreaming;
</script>

{#await setupLocaleResult}
  <div></div>
{:then _locateResult}
  {#if authStatus}
    {#if updatingStatus && typeof updatingStatus !== 'boolean'}
      <UpdatingOverlay details={updatingStatus}></UpdatingOverlay>
    {/if}
    <Main></Main>
  {:else if !isCheckingAuthStatus}
    <Auth></Auth>
  {/if}
{/await}

<Toaster richColors></Toaster>
