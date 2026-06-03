<script lang="ts">
import './app.css';

import { isLocale, loadLocaleAsync } from '@ceraui/i18n';
import { setLocale } from '@ceraui/i18n/svelte';
import { ModeWatcher } from 'mode-watcher';
import { onMount } from 'svelte';

import { getLayoutMode, setLayoutMode } from '$lib/stores/layout-mode.svelte';
import { getLocale } from '$lib/stores/locale.svelte';
import Layout from '$main/Layout.svelte';
import ErrorBoundary from '$main/layout/ErrorBoundary.svelte';

// URL ?mode=touch|default overrides the persisted layout mode on load.
$effect(() => {
	const mode = new URLSearchParams(window.location.search).get('mode');
	if (mode === 'touch') setLayoutMode('touch');
	else if (mode === 'default') setLayoutMode('default');
});

// Reflect the active layout mode onto the document root for CSS token overrides.
$effect(() => {
	document.documentElement.dataset.layoutMode = getLayoutMode();
});

onMount(async () => {
	try {
		// Priority: 1. Saved preference, 2. Browser locale, 3. English fallback
		const savedLocale = getLocale()?.code;
		const browserLocale = typeof window !== 'undefined' ? navigator.language.split('-')[0] : 'en';

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
	</ErrorBoundary>
</main>
