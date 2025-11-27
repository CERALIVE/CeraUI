<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Check, Monitor, Moon, Sun } from '@lucide/svelte';
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
			class="bg-card hover:bg-accent relative flex h-10 w-10 items-center justify-center rounded-xl border p-0 shadow-sm transition-all duration-200 hover:shadow-md"
			title={$LL?.theme?.changeTheme?.() || 'Change theme'}
			variant="ghost"
		>
			<!-- Sun icon - visible in light mode -->
			<Sun
				class="h-5 w-5 scale-100 rotate-0 text-amber-500 transition-all duration-300 dark:absolute dark:scale-0 dark:rotate-90"
			/>
			<!-- Moon icon - visible in dark mode -->
			<Moon
				class="absolute h-5 w-5 scale-0 -rotate-90 text-blue-400 transition-all duration-300 dark:scale-100 dark:rotate-0"
			/>
			<span class="sr-only">{$LL?.theme?.toggleTheme?.() || 'Toggle theme'}</span>
		</Button>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="bg-card w-52 rounded-xl border p-1.5 shadow-xl"
		align="end"
		strategy="fixed"
	>
		<!-- Theme Header -->
		<div class="mb-1 px-2 py-1.5">
			<h4 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
				{$LL?.theme?.selectTheme?.() || 'Select Theme'}
			</h4>
		</div>

		{#each themes as themeOption}
			{@const isActive = theme === themeOption.value}
			<DropdownMenu.Item
				class={cn(
					'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200',
					isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent focus:bg-accent',
				)}
				onclick={() => handleModeChange(themeOption.value)}
			>
				<!-- Theme Icon -->
				<div
					class={cn(
						'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors',
						isActive ? 'bg-primary-foreground/20' : 'bg-muted',
					)}
				>
					{#if themeOption.icon}
						{@const IconComponent = themeOption.icon}
						<IconComponent
							class={cn('h-4 w-4', isActive ? 'text-primary-foreground' : 'text-muted-foreground')}
						/>
					{/if}
				</div>

				<!-- Theme Info -->
				<div class="min-w-0 flex-1">
					<div class={cn('font-medium', isActive ? 'text-primary-foreground' : 'text-foreground')}>
						{$LL?.theme?.[themeOption.value as keyof typeof $LL.theme]?.() ||
							getThemeFallback(themeOption.value)}
					</div>
					<div
						class={cn(
							'truncate text-xs',
							isActive ? 'text-primary-foreground/80' : 'text-muted-foreground',
						)}
					>
						{$LL?.theme?.[`${themeOption.value}Description` as keyof typeof $LL.theme]?.() ||
							getThemeDescriptionFallback(themeOption.value)}
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
