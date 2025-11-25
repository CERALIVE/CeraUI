<script lang="ts">
import './app.css';

import { isLocale, loadLocaleAsync } from '@ceraui/i18n';
import { LL, setLocale } from '@ceraui/i18n/svelte';
import { ModeWatcher } from 'mode-watcher';
import { onMount } from 'svelte';

import { getLocale } from '$lib/stores/locale.svelte';
import Layout from '$main/Layout.svelte';

onMount(async () => {
	try {
		// Priority: 1. Saved preference, 2. Browser locale, 3. English fallback
		const savedLocale = getLocale()?.code;
		const browserLocale = typeof window !== 'undefined' ? navigator.language.split('-')[0] : 'en';

		let targetLocale: string;
		if (savedLocale && isLocale(savedLocale)) {
			targetLocale = savedLocale;
			console.log(`🔄 Using saved locale preference: ${targetLocale}`);
		} else if (isLocale(browserLocale)) {
			targetLocale = browserLocale;
			console.log(`🌐 Using browser locale: ${targetLocale}`);
		} else {
			targetLocale = 'en';
			console.log(`🇺🇸 Using fallback locale: ${targetLocale}`);
		}

		// Load the locale
		await loadLocaleAsync(targetLocale);
		setLocale(targetLocale);

		console.log(`✅ i18n initialized successfully with locale: ${targetLocale}`);
		console.log(`🧪 Test translation:`, $LL.devtools?.title?.());
	} catch (error) {
		console.error('❌ Failed to initialize i18n:', error);
		// Fallback to English
		try {
			await loadLocaleAsync('en');
			setLocale('en');
			console.log('✅ Fallback to English successful');
		} catch (fallbackError) {
			console.error('❌ Even English fallback failed:', fallbackError);
		}
	}
});
</script>

<ModeWatcher />

<main>
	<Layout />
</main>
<!-- test -->
