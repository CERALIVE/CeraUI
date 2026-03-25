<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Check, Moon, Sun } from '@lucide/svelte';
import { resetMode, setMode } from 'mode-watcher';

import { Button } from '$lib/components/ui/button/index.js';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
import { getTheme, setTheme, type ThemeMode } from '$lib/stores/theme.svelte';
import { cn } from '$lib/utils';

let theme = $state(getTheme());

const handleModeChange = (mode: ThemeMode) => {
	if (mode === 'system') {
		resetMode();
	} else {
		setMode(mode);
	}
	setTheme(mode);
	theme = mode;
};

const themes = [
	{ value: 'light' as const, label: () => $LL?.theme?.light?.() || 'Light' },
	{ value: 'dark' as const, label: () => $LL?.theme?.dark?.() || 'Dark' },
	{ value: 'system' as const, label: () => $LL?.theme?.system?.() || 'System' },
] as const;
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		<Button
			class="relative h-9 w-9 rounded-lg"
			title={$LL?.theme?.changeTheme?.() || 'Change theme'}
			variant="ghost"
			size="icon"
		>
			<Sun
				class="h-[1.125rem] w-[1.125rem] scale-100 rotate-0 transition-transform duration-200 dark:scale-0 dark:-rotate-90"
			/>
			<Moon
				class="absolute h-[1.125rem] w-[1.125rem] scale-0 rotate-90 transition-transform duration-200 dark:scale-100 dark:rotate-0"
			/>
			<span class="sr-only">{$LL?.theme?.toggleTheme?.() || 'Toggle theme'}</span>
		</Button>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content class="w-36" align="end" strategy="fixed">
		{#each themes as themeOption}
			{@const isActive = theme === themeOption.value}
			<DropdownMenu.Item
				class={cn(
					'flex cursor-pointer items-center justify-between text-sm',
					isActive && 'font-medium',
				)}
				onclick={() => handleModeChange(themeOption.value)}
			>
				<span>{themeOption.label()}</span>
				{#if isActive}
					<Check class="text-primary h-4 w-4" />
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
