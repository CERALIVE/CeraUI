<script lang="ts">
import { existingLocales, loadLocaleAsync, rtlLanguages } from '@ceraui/i18n';
import { LL, setLocale } from '@ceraui/i18n/svelte';
import { Check, ChevronDown, Globe } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { getLocale, setLocale as setLocaleStore } from '$lib/stores/locale.svelte';
import { cn } from '$lib/utils';

const initialLocale = getLocale();

let selectedLocale: string = $state(initialLocale.code);
let isOpen = $state(false);

const localeName = $derived.by(
	() => existingLocales.find((l) => l.code === selectedLocale)?.name ?? 'English',
);
const localeFlag = $derived.by(() => existingLocales.find((l) => l.code === selectedLocale)?.flag);

// Initialize locale in an effect to avoid top-level state updates
$effect(() => {
	if (initialLocale.code) {
		setLocale(initialLocale.code as any);
	}
});

// Keep <html lang>/<html dir> in sync with the active locale. Layout.svelte owns
// this once mounted, but the selector also renders on the pre-auth screen where
// Layout is absent — so apply it here too (idempotent: both write the same value).
$effect(() => {
	document.documentElement.lang = selectedLocale;
	document.documentElement.dir = rtlLanguages.includes(selectedLocale) ? 'rtl' : 'ltr';
});

const handleLocaleChange = async (value: Parameters<typeof setLocale>[0]) => {
	try {
		await loadLocaleAsync(value as any);
		setLocale(value as any);
		setLocaleStore(existingLocales.find((l) => l.code === value)!);
		selectedLocale = String(value);
		isOpen = false;
	} catch {
		// Locale load failed; prior selection remains
	}
};
</script>

<DropdownMenu.Root bind:open={isOpen}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				class="bg-card hover:bg-accent flex h-11 items-center gap-2 rounded-xl border px-3 transition-colors"
				data-testid="locale-selector"
				variant="ghost"
			>
				{#if localeFlag}
					<span class="text-base leading-none" aria-label={localeName} role="img">{localeFlag}</span
					>
				{:else}
					<Globe class="text-muted-foreground size-4" />
				{/if}
				<span class="text-sm font-medium">{localeName}</span>
				<ChevronDown
					class={cn(
						'text-muted-foreground size-4 transition-transform duration-200',
						isOpen && 'rotate-180',
					)}
				/>
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="bg-card w-60 rounded-xl border p-1.5 shadow-xl"
		align="end"
		strategy="fixed"
	>
		<div class="px-2 py-1.5">
			<h4 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
				{$LL.locale.selectLanguage()}
			</h4>
		</div>

		<div class="max-h-[min(60vh,22rem)] overflow-y-auto pe-0.5">
			{#each existingLocales as localeOption}
				{@const isActive = selectedLocale === localeOption.code}
				<DropdownMenu.Item
					class={cn(
						'mt-0.5 flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors first:mt-0',
						isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent focus:bg-accent',
					)}
					data-testid="locale-option-{localeOption.code}"
					onclick={() => handleLocaleChange(localeOption.code)}
				>
					<div
						class={cn(
							'flex size-8 shrink-0 items-center justify-center rounded-lg text-base leading-none transition-colors',
							isActive ? 'bg-primary-foreground/20' : 'bg-muted',
						)}
					>
						{#if localeOption.flag}
							<span aria-label={localeOption.name} role="img">{localeOption.flag}</span>
						{:else}
							<Globe
								class={cn('size-4', isActive ? 'text-primary-foreground' : 'text-muted-foreground')}
							/>
						{/if}
					</div>

					<div class="min-w-0 flex-1">
						<div
							class={cn(
								'truncate font-medium',
								isActive ? 'text-primary-foreground' : 'text-foreground',
							)}
						>
							{localeOption.name}
						</div>
						<div
							class={cn(
								'font-mono text-xs',
								isActive ? 'text-primary-foreground/80' : 'text-muted-foreground',
							)}
						>
							{localeOption.code.toUpperCase()}
						</div>
					</div>

					{#if isActive}
						<Check class="text-primary-foreground size-4 shrink-0" />
					{/if}
				</DropdownMenu.Item>
			{/each}
		</div>
	</DropdownMenu.Content>
</DropdownMenu.Root>
