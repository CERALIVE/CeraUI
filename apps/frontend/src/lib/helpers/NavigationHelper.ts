import { type NavElements, navElements } from '$lib/config';
import General from '$main/tabs/General.svelte';

/**
 * Options for customizing hash navigation behavior
 */
export interface HashNavigationOptions {
  /** Custom fallback navigation element if hash doesn't match any existing elements */
  fallbackElement?: NavElements;
  /** Whether to perform case-sensitive matching (defaults to true) */
  caseSensitive?: boolean;
  /** Custom hash string to parse instead of window.location.hash */
  customHash?: string;
}

/**
 * Options for controlling hash update behavior
 */
export interface UpdateHashOptions {
  /** Whether to use replaceState instead of pushState (defaults to false) */
  replaceState?: boolean;
  /** Whether to prevent updating duplicate hashes (defaults to true) */
  preventDuplicate?: boolean;
}

/**
 * Advanced options for hash navigation setup
 */
export interface SetupHashNavigationOptions {
  /** Debounce delay for hash change events in milliseconds (defaults to 0) */
  debounceMs?: number;
  /** Custom event target to listen for hash changes (defaults to window) */
  customEventTarget?: EventTarget;
  /** Whether to prevent the initial hash update when subscribing to store changes (defaults to false) */
  preventInitialUpdate?: boolean;
}

/**
 * Get the navigation element that matches the current URL hash
 * @param options Optional configuration for hash parsing behavior
 * @returns The matching navigation element or fallback
 */
export function getNavFromHash(options?: HashNavigationOptions): NavElements {
  const defaultNav = { general: { label: 'general', component: General } };
  const { fallbackElement = defaultNav, caseSensitive = true, customHash } = options ?? {};

  const hash = (customHash ?? window.location.hash).slice(1); // Remove the # character

  if (!hash) return fallbackElement;

  // Find the navigation element with matching label
  for (const [identifier, nav] of Object.entries(navElements)) {
    const labelToCompare = caseSensitive ? nav.label : nav.label.toLowerCase();
    const hashToCompare = caseSensitive ? hash : hash.toLowerCase();

    if (labelToCompare === hashToCompare) {
      return { [identifier]: nav };
    }
  }

  return fallbackElement;
}

/**
 * Update the URL hash based on the current navigation
 * @param navigation The navigation element to set in the hash
 * @param options Optional configuration for hash update behavior
 */
export function updateHash(navigation: NavElements, options?: UpdateHashOptions): void {
  if (!navigation) return;

  const { replaceState = false, preventDuplicate = true } = options ?? {};

  const identifier = Object.keys(navigation)[0];
  const navElement = navigation[identifier];
  const newHash = `#${navElement.label}`;

  // Only update if hash is different to avoid unnecessary refreshes (when preventDuplicate is true)
  if (!preventDuplicate || window.location.hash !== newHash) {
    if (replaceState) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
  }
}

/**
 * Setup hash-based navigation
 * @param navigationStore The store to sync with the URL hash
 * @param setInitialState Whether to set the initial navigation state from the current hash (defaults to true)
 * @param options Optional advanced configuration for hash navigation setup
 * @returns A cleanup function
 */
export function setupHashNavigation(
  navigationStore: {
    set: (value: NavElements) => void;
    subscribe: (callback: (value: NavElements) => void) => () => void;
  },
  setInitialState: boolean = true,
  options?: SetupHashNavigationOptions,
): () => void {
  const { debounceMs = 0, customEventTarget = window, preventInitialUpdate = false } = options ?? {};

  // Set initial navigation based on hash only if explicitly requested
  if (setInitialState) {
    const initialNav = getNavFromHash();
    navigationStore.set(initialNav);
  }

  // Debounced handler for hash changes
  let debounceTimeout: number | undefined;
  const handleHashChange = () => {
    const _currentHash = window.location.hash;

    // Set flag to prevent circular updates
    isUpdatingFromHash = true;

    if (debounceMs > 0) {
      clearTimeout(debounceTimeout);
      debounceTimeout = window.setTimeout(() => {
        const navFromHash = getNavFromHash();
        navigationStore.set(navFromHash);
        // Reset flag after store update
        setTimeout(() => {
          isUpdatingFromHash = false;
        }, 0);
      }, debounceMs);
    } else {
      const navFromHash = getNavFromHash();
      navigationStore.set(navFromHash);
      // Reset flag after store update
      setTimeout(() => {
        isUpdatingFromHash = false;
      }, 0);
    }
  };

  // Listen for hash changes on the specified event target
  customEventTarget.addEventListener('hashchange', handleHashChange);

  // Track if this is the initial subscription to prevent unwanted updates
  let isInitialSubscription = true;
  let isUpdatingFromHash = false; // Flag to prevent circular updates

  // Subscribe to navigation changes
  const unsubscribe = navigationStore.subscribe(navigation => {
    if (navigation && !(preventInitialUpdate && isInitialSubscription) && !isUpdatingFromHash) {
      const navKey = Object.keys(navigation)[0];
      const navLabel = navigation[navKey].label;
      const newHash = `#${navLabel}`;
      const currentHash = window.location.hash;

      // CRITICAL FIX: Only update hash if it's actually different
      if (currentHash !== newHash) {
        updateHash(navigation);
      }
    }
    isInitialSubscription = false;
  });

  // Return cleanup function
  return () => {
    customEventTarget.removeEventListener('hashchange', handleHashChange);
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
    }
    unsubscribe();
  };
}
