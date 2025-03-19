import { defaultNavElement, type NavElements, navElements } from '$lib/config';

/**
 * Get the navigation element that matches the current URL hash
 */
export function getNavFromHash(): NavElements {
  const hash = window.location.hash.slice(1); // Remove the # character

  if (!hash) return defaultNavElement;

  // Find the navigation element with matching label
  for (const [identifier, nav] of Object.entries(navElements)) {
    if (nav.label === hash) {
      return { [identifier]: nav };
    }
  }

  return defaultNavElement;
}

/**
 * Update the URL hash based on the current navigation
 */
export function updateHash(navigation: NavElements): void {
  if (!navigation) return;

  const identifier = Object.keys(navigation)[0];
  const navElement = navigation[identifier];

  // Only update if hash is different to avoid unnecessary refreshes
  if (window.location.hash !== `#${navElement.label}`) {
    history.pushState(null, '', `#${navElement.label}`);
  }
}

/**
 * Setup hash-based navigation
 * @param navigationStore The store to sync with the URL hash
 * @returns A cleanup function
 */
export function setupHashNavigation(navigationStore: {
  set: (value: NavElements) => void;
  subscribe: (callback: (value: NavElements) => void) => () => void;
}): () => void {
  // Set initial navigation based on hash
  const initialNav = getNavFromHash();
  navigationStore.set(initialNav);

  // Handler for hash changes
  const handleHashChange = () => {
    const navFromHash = getNavFromHash();
    navigationStore.set(navFromHash);
  };

  // Listen for hash changes
  window.addEventListener('hashchange', handleHashChange);

  // Subscribe to navigation changes
  const unsubscribe = navigationStore.subscribe(navigation => {
    if (navigation) {
      updateHash(navigation);
    }
  });

  // Return cleanup function
  return () => {
    window.removeEventListener('hashchange', handleHashChange);
    unsubscribe();
  };
}
