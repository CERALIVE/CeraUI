<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Check, Monitor, Moon, Sun } from '@lucide/svelte';
import { resetMode, setMode } from 'mode-watcher';

import { Button } from '$lib/components/ui/button/index.js';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
import { getTheme, resolveSystemMode, setTheme, type ThemeMode } from '$lib/stores/theme.svelte';
import { cn } from '$lib/utils';

let theme = $state(getTheme());

const handleModeChange = (mode: ThemeMode) => {
	if (mode === 'system') {
		// resetMode hands control back to mode-watcher, which resolves the system
		// preference the same way resolveSystemMode does: headless → dark.
		resetMode();
	} else {
		setMode(mode);
	}
	setTheme(mode);
	theme = mode;
};

const themes = [
	{ value: 'light' as const, icon: Sun, label: () => $LL?.theme?.light?.() || 'Light' },
	{ value: 'dark' as const, icon: Moon, label: () => $LL?.theme?.dark?.() || 'Dark' },
	{ value: 'system' as const, icon: Monitor, label: () => $LL?.theme?.system?.() || 'System' },
] as const;

const systemResolvedLabel = $derived(
	resolveSystemMode() === 'dark'
		? $LL?.theme?.dark?.() || 'Dark'
		: $LL?.theme?.light?.() || 'Light',
);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				class="relative h-9 w-9 rounded-lg"
				data-testid="theme-toggle"
				size="icon"
				title={$LL?.theme?.changeTheme?.() || 'Change theme'}
				variant="ghost"
			>
				<Sun
					class="h-[1.125rem] w-[1.125rem] scale-100 rotate-0 transition-transform duration-200 dark:scale-0 dark:-rotate-90"
				/>
				<Moon
					class="absolute h-[1.125rem] w-[1.125rem] scale-0 rotate-90 transition-transform duration-200 dark:scale-100 dark:rotate-0"
				/>
				<span class="sr-only">{$LL?.theme?.toggleTheme?.() || 'Toggle theme'}</span>
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="bg-card w-56 rounded-xl border p-1.5 shadow-xl"
		align="end"
		strategy="fixed"
	>
		<div class="px-2 py-1.5">
			<h4 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
				{$LL?.theme?.changeTheme?.() || 'Change theme'}
			</h4>
		</div>

		{#each themes as themeOption (themeOption.value)}
			{@const Icon = themeOption.icon}
			{@const isActive = theme === themeOption.value}
			<DropdownMenu.Item
				class={cn(
					'mt-0.5 flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors first:mt-0',
					isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent focus:bg-accent',
				)}
				data-testid="theme-option-{themeOption.value}"
				onclick={() => handleModeChange(themeOption.value)}
			>
				<div
					class={cn(
						'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
						isActive ? 'bg-primary-foreground/20' : 'bg-muted',
					)}
				>
					<Icon
						class={cn('size-4', isActive ? 'text-primary-foreground' : 'text-muted-foreground')}
					/>
				</div>

				<div class="min-w-0 flex-1">
					<div
						class={cn(
							'truncate font-medium',
							isActive ? 'text-primary-foreground' : 'text-foreground',
						)}
					>
						{themeOption.label()}
					</div>
					{#if themeOption.value === 'system'}
						<div
							class={cn(
								'font-mono text-xs',
								isActive ? 'text-primary-foreground/80' : 'text-muted-foreground',
							)}
						>
							{systemResolvedLabel}
						</div>
					{/if}
				</div>

				{#if isActive}
					<Check class="text-primary-foreground size-4 shrink-0" />
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
