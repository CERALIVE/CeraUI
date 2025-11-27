<script lang="ts">
import { existingLocales, loadLocaleAsync } from '@ceraui/i18n';
import { LL, setLocale } from '@ceraui/i18n/svelte';
import { Check, ChevronDown, Globe } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { getLocale, setLocale as setLocaleStore } from '$lib/stores/locale.svelte';
import { cn } from '$lib/utils';

const initialLocale = getLocale();

let selectedLocale = $state(initialLocale.code);
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

const handleLocaleChange = async (value: string) => {
	try {
		console.log(`🌍 Loading locale: ${value}`);
		await loadLocaleAsync(value as any);
		setLocale(value as any);
		setLocaleStore(existingLocales.find((l) => l.code === value)!);
		selectedLocale = value;
		isOpen = false;
		console.log(`✅ Successfully switched to locale: ${value}`);
	} catch (error) {
		console.error(`❌ Failed to load locale ${value}:`, error);
	}
};
</script>

<DropdownMenu.Root bind:open={isOpen}>
	<DropdownMenu.Trigger>
		<Button
			class="bg-card hover:bg-accent flex h-10 items-center gap-2 rounded-xl border px-3 shadow-sm transition-all duration-200 hover:shadow-md"
			variant="ghost"
		>
			{#if localeFlag}
				<span class="text-base" aria-label={localeName} role="img">{localeFlag}</span>
			{:else}
				<Globe class="text-muted-foreground h-4 w-4" />
			{/if}
			<span class="text-sm font-medium">{localeName}</span>
			<ChevronDown
				class={cn(
					'text-muted-foreground h-4 w-4 transition-transform duration-200',
					isOpen && 'rotate-180',
				)}
			/>
		</Button>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="bg-card w-56 rounded-xl border p-1.5 shadow-xl"
		align="end"
		strategy="fixed"
	>
		<!-- Language Header -->
		<div class="mb-1 px-2 py-1.5">
			<h4 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
				{$LL.locale.selectLanguage()}
			</h4>
		</div>

		{#each existingLocales as localeOption}
			{@const isActive = selectedLocale === localeOption.code}
			<DropdownMenu.Item
				class={cn(
					'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200',
					isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent focus:bg-accent',
				)}
				onclick={() => handleLocaleChange(localeOption.code)}
			>
				<!-- Language Flag/Icon -->
				<div
					class={cn(
						'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base transition-colors',
						isActive ? 'bg-primary-foreground/20' : 'bg-muted',
					)}
				>
					{#if localeOption.flag}
						<span aria-label={localeOption.name} role="img">{localeOption.flag}</span>
					{:else}
						<Globe
							class={cn('h-4 w-4', isActive ? 'text-primary-foreground' : 'text-muted-foreground')}
						/>
					{/if}
				</div>

				<!-- Language Info -->
				<div class="min-w-0 flex-1">
					<div class={cn('font-medium', isActive ? 'text-primary-foreground' : 'text-foreground')}>
						{localeOption.name}
					</div>
					<div
						class={cn('text-xs', isActive ? 'text-primary-foreground/80' : 'text-muted-foreground')}
					>
						{localeOption.code.toUpperCase()}
					</div>
				</div>

				<!-- Active Indicator -->
				{#if isActive}
					<Check class="text-primary-foreground h-4 w-4 shrink-0" />
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
