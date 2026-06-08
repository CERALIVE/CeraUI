<script lang="ts">
import './app.css';

import { isLocale, loadLocaleAsync } from '@ceraui/i18n';
import { setLocale } from '@ceraui/i18n/svelte';
import { ModeWatcher, setTheme as setCustomTheme } from 'mode-watcher';
import { onMount, untrack } from 'svelte';

import BootShell from '$lib/components/custom/BootShell.svelte';
import { getConnectionReady } from '$lib/rpc/subscriptions.svelte';
import {
	getDisplayProfile,
	parseDisplayProfile,
	prefersEinkTheme,
	setDisplayProfile,
} from '$lib/stores/display-profile.svelte';
import { getLayoutMode, setLayoutMode } from '$lib/stores/layout-mode.svelte';
import { getLocale } from '$lib/stores/locale.svelte';
import { getShouldShowOfflinePage } from '$lib/stores/offline-state.svelte';
import Layout from '$main/Layout.svelte';
import ErrorBoundary from '$main/layout/ErrorBoundary.svelte';

// Boot gate: Layout mounts immediately (optimistic shell — auth + offline logic
// run underneath) while BootShell overlays "Connecting to device…" until the
// device first speaks. Event-driven via getConnectionReady(); yields to the
// browser-offline page when that takes over so it never masks a real outage.
const showBootShell = $derived(!getConnectionReady() && !getShouldShowOfflinePage());

// URL ?mode=touch|default overrides the persisted layout mode on load.
$effect(() => {
	const mode = new URLSearchParams(window.location.search).get('mode');
	if (mode === 'touch') setLayoutMode('touch');
	else if (mode === 'default') setLayoutMode('default');
});

// URL ?display=lcd|eink|mono overrides the persisted display profile on load.
// Only applied when the param is present so an in-SPA reload without it keeps
// the persisted profile (mirrors the ?mode handling above). Unknown values
// normalize to the default (lcd) via parseDisplayProfile.
$effect(() => {
	const display = new URLSearchParams(window.location.search).get('display');
	if (display !== null) setDisplayProfile(parseDisplayProfile(display));
});

// Reflect the active layout mode onto the document root for CSS token overrides.
$effect(() => {
	document.documentElement.dataset.layoutMode = getLayoutMode();
});

// Reflect the active display profile onto the document root: data-display always,
// plus data-theme="eink" for the e-ink/mono profiles. mode-watcher owns the
// <html> data-theme attribute (its $derived writer clobbers any direct write),
// so route through its setTheme — cleared to '' for lcd. The setter performs
// reactive reads internally; untrack keeps those out of this effect's
// dependency set so writing the theme never re-triggers the effect (which would
// otherwise read-and-write the same state → effect_update_depth_exceeded).
$effect(() => {
	const profile = getDisplayProfile();
	document.documentElement.dataset.display = profile;
	untrack(() => setCustomTheme(prefersEinkTheme(profile) ? 'eink' : ''));
});

onMount(async () => {
	try {
		// Priority: 1. Saved preference, 2. Browser locale, 3. English fallback
		const savedLocale = getLocale()?.code;
		const browserLocale = typeof window !== 'undefined' ? (navigator.language.split('-')[0] ?? 'en') : 'en';

		let targetLocale: string;
		if (savedLocale && isLocale(savedLocale)) {
			targetLocale = savedLocale;
		} else if (isLocale(browserLocale)) {
			targetLocale = browserLocale;
		} else {
			targetLocale = 'en';
		}

		// Load the locale
		await loadLocaleAsync(targetLocale as Parameters<typeof loadLocaleAsync>[0]);
		setLocale(targetLocale as Parameters<typeof setLocale>[0]);
	} catch (error) {
		console.error('Failed to initialize i18n:', error);
		// Fallback to English
		try {
			await loadLocaleAsync('en');
			setLocale('en');
		} catch (fallbackError) {
			console.error('Critical: Even English fallback failed:', fallbackError);
		}
	}
});
</script>

<ModeWatcher />

<main>
	<ErrorBoundary>
		<Layout />
		{#if showBootShell}
			<BootShell />
		{/if}
	</ErrorBoundary>
</main>
