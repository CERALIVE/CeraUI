<script lang="ts">
import { type Locales } from '@ceraui/i18n';
import { LL } from '@ceraui/i18n/svelte';
import { Globe } from '@lucide/svelte';

import SystemCollapsibleSection from '$lib/components/dev-tools/system-collapsible-section.svelte';

type LocaleInfo = {
	currentLocale: string;
	currentLanguageName: string;
	currentLanguageFlag: string;
	browserLanguage: string;
	supportedLocales: Array<{ code: string; name: string; flag?: string }>;
};

let {
	localeInfo,
	onLanguageClick,
}: { localeInfo: LocaleInfo; onLanguageClick: (languageCode: Locales) => void } = $props();
</script>

<!-- Locale & Language Information -->
<SystemCollapsibleSection icon={Globe} title="App Locale & Language">
	<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.currentLanguage()}</div>
				<div class="flex items-center gap-2 text-sm font-medium">
					<span class="text-lg">{localeInfo.currentLanguageFlag}</span>
					{localeInfo.currentLanguageName}
					<span class="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs"
						>{$LL.devtools.active()}</span
					>
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.localeCode()}</div>
				<div class="font-mono text-sm font-medium text-primary">{localeInfo.currentLocale}</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browserLanguage()}</div>
				<div class="font-mono text-sm font-medium text-muted-foreground">
					{localeInfo.browserLanguage}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3 md:col-span-3">
				<div class="text-muted-foreground mb-2 text-xs">
					{$LL.devtools.supportedLanguagesClick({
						count: localeInfo.supportedLocales.length,
					})}
				</div>
				<div class="flex flex-wrap gap-1">
					{#each localeInfo.supportedLocales as supportedLocale}
						<button
							class="bg-background flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors hover:bg-accent {supportedLocale.code ===
							localeInfo.currentLocale
								? 'bg-primary/10 border-primary/30 text-primary ring-primary/20 ring-1'
								: 'hover:bg-primary/5 hover:border-primary/20'}"
							onclick={() => onLanguageClick(supportedLocale.code as Locales)}
							aria-label="Switch to {supportedLocale.name}"
							type="button"
						>
							<span class="text-base">{supportedLocale.flag || '🌐'}</span>
							<span class="font-medium">{supportedLocale.code.toUpperCase()}</span>
						</button>
					{/each}
				</div>
			</div>
	</div>
</SystemCollapsibleSection>
