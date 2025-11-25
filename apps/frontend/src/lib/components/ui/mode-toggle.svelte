<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Monitor, Moon, Sun } from '@lucide/svelte';
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

// Enhanced theme information
const themes = [
	{
		value: 'light' as const,
		icon: Sun,
	},
	{
		value: 'dark' as const,
		icon: Moon,
	},
	{
		value: 'system' as const,
		icon: Monitor,
	},
] as const;

// Theme fallbacks for when i18n isn't loaded yet
const getThemeFallback = (value: string) => {
	switch (value) {
		case 'light':
			return 'Light';
		case 'dark':
			return 'Dark';
		case 'system':
			return 'System';
		default:
			return value;
	}
};

const getThemeDescriptionFallback = (value: string) => {
	switch (value) {
		case 'light':
			return 'Clean and bright interface';
		case 'dark':
			return 'Easy on the eyes';
		case 'system':
			return 'Match your device';
		default:
			return `${value} theme`;
	}
};
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		<Button
			class="h-10 w-10 rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 p-0 shadow-sm transition-all duration-200 hover:from-gray-200 hover:to-gray-300 hover:shadow-md dark:from-gray-800 dark:to-gray-900 dark:hover:from-gray-700 dark:hover:to-gray-800"
			title={$LL?.theme?.changeTheme?.() || 'Change theme'}
			variant="ghost"
		>
			<!-- Enhanced Icon Animation -->
			<div class="relative h-5 w-5">
				<Sun
					class="absolute h-5 w-5 scale-100 rotate-0 text-amber-500 transition-all duration-300 dark:scale-0 dark:rotate-90"
				/>
				<Moon
					class="absolute h-5 w-5 scale-0 -rotate-90 text-blue-400 transition-all duration-300 dark:scale-100 dark:rotate-0"
				/>
			</div>
			<span class="sr-only">{$LL?.theme?.toggleTheme?.() || 'Toggle theme'}</span>
		</Button>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="w-48 rounded-xl border-2 bg-white/95 p-2 shadow-xl backdrop-blur-md dark:bg-gray-900/95"
		align="end"
		strategy="fixed"
	>
		<!-- Theme Header -->
		<div class="mb-2 px-2 py-1">
			<h4 class="text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
				{$LL?.theme?.selectTheme?.() || 'Select Theme'}
			</h4>
		</div>

		{#each themes as themeOption}
			{@const isActive = theme === themeOption.value}
			<DropdownMenu.Item
				class={cn(
					'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200',
					isActive
						? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-md'
						: 'hover:bg-gray-100 dark:hover:bg-gray-800',
				)}
				onclick={() => handleModeChange(themeOption.value)}
			>
				<!-- Theme Icon -->
				<div
					class={cn(
						'grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors',
						isActive
							? 'bg-white/20 text-white'
							: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
					)}
				>
					{#if themeOption.icon}
						{@const IconComponent = themeOption.icon}
						<IconComponent class="h-4 w-4" />
					{/if}
				</div>

				<!-- Theme Info -->
				<div class="flex-1">
					<div
						class={cn('font-medium', isActive ? 'text-white' : 'text-gray-900 dark:text-gray-100')}
					>
						{$LL?.theme?.[themeOption.value as keyof typeof $LL.theme]?.() ||
							getThemeFallback(themeOption.value)}
					</div>
					<div
						class={cn('text-xs', isActive ? 'text-white/80' : 'text-gray-500 dark:text-gray-400')}
					>
						{$LL?.theme?.[`${themeOption.value}Description` as keyof typeof $LL.theme]?.() ||
							getThemeDescriptionFallback(themeOption.value)}
					</div>
				</div>

				<!-- Active Indicator -->
				{#if isActive}
					<div class="h-2 w-2 rounded-full bg-white shadow-sm"></div>
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
