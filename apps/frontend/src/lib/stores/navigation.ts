import { derived, writable } from 'svelte/store';

import { type NavElements, navElements } from '$lib/config';
import General from '$main/tabs/General.svelte';

// Navigation state with additional reactive properties
interface NavigationState {
  current: NavElements;
  previous: NavElements | null;
  isTransitioning: boolean;
  transitionDirection: 'forward' | 'backward' | null;
  history: NavElements[];
  error: string | null;
}

// Create enhanced navigation state
function createNavigationStore() {
  // Initialize with empty state to avoid circular dependency
  const initialState: NavigationState = {
    current: { general: { label: 'general', component: General } }, // Direct import to avoid circular deps
    previous: null,
    isTransitioning: false,
    transitionDirection: null,
    history: [{ general: { label: 'general', component: General } }],
    error: null,
  };

  const { subscribe, set, update } = writable<NavigationState>(initialState);

  return {
    subscribe,

    // Navigate to a new element with transition tracking
    navigateTo: (navigation: NavElements) => {
      update((state) => {
        const currentKey = Object.keys(state.current)[0];
        const newKey = Object.keys(navigation)[0];

        // Prevent navigation to the same component to avoid race conditions
        if (currentKey === newKey) {
          return state; // Return unchanged state
        }

        // Prevent navigation while transitioning to avoid overlapping transitions
        if (state.isTransitioning) {
          return state; // Return unchanged state
        }

        // Determine transition direction based on navigation order
        const navKeys = Object.keys(navElements);
        const currentIndex = navKeys.indexOf(currentKey);
        const newIndex = navKeys.indexOf(newKey);
        const direction = newIndex > currentIndex ? 'forward' : 'backward';

        // Add to history only if it's different from current (prevents duplicates)
        const newHistory =
          currentKey !== newKey
            ? [...state.history.slice(-9), navigation] // Keep last 10 items
            : state.history;

        return {
          ...state,
          previous: state.current,
          current: navigation,
          transitionDirection: direction,
          history: newHistory,
          error: null,
        };
      });
    },

    // Set transition state
    setTransitioning: (isTransitioning: boolean) => {
      update((state) => ({ ...state, isTransitioning }));
    },

    // Set error state
    setError: (error: string | null) => {
      update((state) => ({ ...state, error }));
    },

    // Go back in history
    goBack: () => {
      update((state) => {
        if (state.history.length > 1) {
          const newHistory = state.history.slice(0, -1);
          const previous = newHistory[newHistory.length - 1];
          return {
            ...state,
            previous: state.current,
            current: previous,
            history: newHistory,
            transitionDirection: 'backward',
            error: null,
          };
        }
        return state;
      });
    },

    // Reset to initial state
    reset: () => set(initialState),
  };
}

// Enhanced navigation store
const enhancedNavigationStore = createNavigationStore();

// Derived stores for convenient access to specific properties
export const currentNavigation = derived(enhancedNavigationStore, ($nav) => $nav.current);
export const isNavigationTransitioning = derived(
  enhancedNavigationStore,
  ($nav) => $nav.isTransitioning
);
export const navigationError = derived(enhancedNavigationStore, ($nav) => $nav.error);
export const navigationHistory = derived(enhancedNavigationStore, ($nav) => $nav.history);
export const canGoBack = derived(enhancedNavigationStore, ($nav) => $nav.history.length > 1);
export const transitionDirection = derived(
  enhancedNavigationStore,
  ($nav) => $nav.transitionDirection
);
export const previousNavigation = derived(enhancedNavigationStore, ($nav) => $nav.previous);

// Backward compatible navigation store that maintains the original interface
const navigationStore = {
  subscribe: currentNavigation.subscribe,
  set: (navigation: NavElements) => enhancedNavigationStore.navigateTo(navigation),
  update: (fn: (current: NavElements) => NavElements) => {
    let current: NavElements = { general: { label: 'general', component: General } };
    const unsubscribe = currentNavigation.subscribe((nav) => (current = nav));
    unsubscribe();
    const updated = fn(current);
    enhancedNavigationStore.navigateTo(updated);
  },
};

// Export the enhanced store for internal use
export { enhancedNavigationStore };

// Export the legacy interface for backward compatibility
export { navigationStore };
