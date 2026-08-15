<script lang="ts">
import './app.css';

import { initLocale } from '@ceraui/i18n/svelte';
import { setLocale as setLegacyLocale } from '@ceraui/i18n/i18n-svelte5';
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
	// Startup priority: saved preference -> navigator.language -> en. Paraglide
	// is synchronous (every namespace is eager), so only the legacy adapter still
	// needs its async dictionary fetch; it coexists until the plan's call-site
	// codemod lands.
	const active = initLocale({ saved: getLocale()?.code });
	try {
		await setLegacyLocale(active as Parameters<typeof setLegacyLocale>[0]);
	} catch (error) {
		console.error('Failed to initialize the legacy i18n adapter:', error);
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
