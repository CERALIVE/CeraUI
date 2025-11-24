// Navigation store using Svelte 5 runes
import { type NavElements, navElements } from "$lib/config";
import General from "$main/tabs/General.svelte";

// Navigation state interface
interface NavigationState {
	current: NavElements;
	previous: NavElements | null;
	isTransitioning: boolean;
	transitionDirection: "forward" | "backward" | null;
	history: NavElements[];
	error: string | null;
}

// Initial state
const initialState: NavigationState = {
	current: { general: { label: "general", component: General } },
	previous: null,
	isTransitioning: false,
	transitionDirection: null,
	history: [{ general: { label: "general", component: General } }],
	error: null,
};

// Reactive state using $state
let navigationState = $state<NavigationState>({ ...initialState });

// Subscriber management for store compatibility
type Subscriber<T> = (value: T) => void;
const stateSubscribers = new Set<Subscriber<NavigationState>>();
const currentSubscribers = new Set<Subscriber<NavElements>>();
const transitioningSubscribers = new Set<Subscriber<boolean>>();
const errorSubscribers = new Set<Subscriber<string | null>>();
const historySubscribers = new Set<Subscriber<NavElements[]>>();
const canGoBackSubscribers = new Set<Subscriber<boolean>>();
const directionSubscribers = new Set<Subscriber<"forward" | "backward" | null>>();
const previousSubscribers = new Set<Subscriber<NavElements | null>>();

function notifyAllSubscribers() {
	for (const sub of stateSubscribers) sub(navigationState);
	for (const sub of currentSubscribers) sub(navigationState.current);
	for (const sub of transitioningSubscribers) sub(navigationState.isTransitioning);
	for (const sub of errorSubscribers) sub(navigationState.error);
	for (const sub of historySubscribers) sub(navigationState.history);
	for (const sub of canGoBackSubscribers) sub(navigationState.history.length > 1);
	for (const sub of directionSubscribers) sub(navigationState.transitionDirection);
	for (const sub of previousSubscribers) sub(navigationState.previous);
}

// Getters
export function getCurrentNavigation(): NavElements {
	return navigationState.current;
}

export function getIsTransitioning(): boolean {
	return navigationState.isTransitioning;
}

export function getNavigationError(): string | null {
	return navigationState.error;
}

export function getNavigationHistory(): NavElements[] {
	return navigationState.history;
}

export function getCanGoBack(): boolean {
	return navigationState.history.length > 1;
}

export function getTransitionDirection(): "forward" | "backward" | null {
	return navigationState.transitionDirection;
}

export function getPreviousNavigation(): NavElements | null {
	return navigationState.previous;
}

// Actions
export function navigateTo(navigation: NavElements): void {
	const currentKey = Object.keys(navigationState.current)[0];
	const newKey = Object.keys(navigation)[0];

	// Prevent navigation to the same component
	if (currentKey === newKey) return;

	// Prevent navigation while transitioning
	if (navigationState.isTransitioning) return;

	// Determine transition direction
	const navKeys = Object.keys(navElements);
	const currentIndex = navKeys.indexOf(currentKey);
	const newIndex = navKeys.indexOf(newKey);
	const direction = newIndex > currentIndex ? "forward" : "backward";

	// Update state
	navigationState = {
		...navigationState,
		previous: navigationState.current,
		current: navigation,
		transitionDirection: direction,
		history: [...navigationState.history.slice(-9), navigation],
		error: null,
	};
	notifyAllSubscribers();
}

export function setTransitioning(isTransitioning: boolean): void {
	navigationState = { ...navigationState, isTransitioning };
	notifyAllSubscribers();
}

export function setNavigationError(error: string | null): void {
	navigationState = { ...navigationState, error };
	notifyAllSubscribers();
}

export function goBack(): void {
	if (navigationState.history.length > 1) {
		const newHistory = navigationState.history.slice(0, -1);
		const previous = newHistory[newHistory.length - 1];
		navigationState = {
			...navigationState,
			previous: navigationState.current,
			current: previous,
			history: newHistory,
			transitionDirection: "backward",
			error: null,
		};
		notifyAllSubscribers();
	}
}

export function resetNavigation(): void {
	navigationState = { ...initialState };
	notifyAllSubscribers();
}

// Store-compatible subscriptions
function createSubscription<T>(
	subscribers: Set<Subscriber<T>>,
	getValue: () => T
): (callback: Subscriber<T>) => () => void {
	return (callback: Subscriber<T>) => {
		subscribers.add(callback);
		callback(getValue());
		return () => subscribers.delete(callback);
	};
}

// Derived store equivalents with subscribe methods
export const currentNavigation = {
	get value() { return navigationState.current; },
	subscribe: createSubscription(currentSubscribers, () => navigationState.current),
};

export const isNavigationTransitioning = {
	get value() { return navigationState.isTransitioning; },
	subscribe: createSubscription(transitioningSubscribers, () => navigationState.isTransitioning),
};

export const navigationError = {
	get value() { return navigationState.error; },
	subscribe: createSubscription(errorSubscribers, () => navigationState.error),
};

export const navigationHistory = {
	get value() { return navigationState.history; },
	subscribe: createSubscription(historySubscribers, () => navigationState.history),
};

export const canGoBack = {
	get value() { return navigationState.history.length > 1; },
	subscribe: createSubscription(canGoBackSubscribers, () => navigationState.history.length > 1),
};

export const transitionDirection = {
	get value() { return navigationState.transitionDirection; },
	subscribe: createSubscription(directionSubscribers, () => navigationState.transitionDirection),
};

export const previousNavigation = {
	get value() { return navigationState.previous; },
	subscribe: createSubscription(previousSubscribers, () => navigationState.previous),
};

// Enhanced navigation store (internal)
export const enhancedNavigationStore = {
	subscribe: createSubscription(stateSubscribers, () => navigationState),
	navigateTo,
	setTransitioning,
	setError: setNavigationError,
	goBack,
	reset: resetNavigation,
};

// Legacy-compatible navigation store
export const navigationStore = {
	subscribe: currentNavigation.subscribe,
	set: navigateTo,
	update: (fn: (current: NavElements) => NavElements) => {
		const updated = fn(navigationState.current);
		navigateTo(updated);
	},
};

