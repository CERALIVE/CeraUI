/**
 * A REACTIVE navigation double for `NavigationRenderer.svelte`.
 *
 * The production `getCurrentNavigation()` reads a `$state` object, so the
 * renderer's `$derived` component and destination key re-resolve on every
 * navigation. A plain `vi.fn()` double is not reactive and would prove only
 * that the first destination renders.
 */
import type { Component } from "svelte";

type NavEntry = Record<string, { component?: Component }>;

let current = $state<NavEntry>({});

export function getCurrentNavigationFeed(): NavEntry {
	return current;
}

export function publishNavigation(next: NavEntry): void {
	current = next;
}

export function resetNavigationFeed(): void {
	current = {};
}
