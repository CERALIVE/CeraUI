<style>
/* Enhanced mobile touch interactions */
button {
	-webkit-tap-highlight-color: transparent;
	touch-action: manipulation;
}

/* Enhanced disabled state */
button:disabled {
	cursor: not-allowed;
}
</style>

<script lang="ts">
import { cn } from '$lib/utils.js';

interface Props {
	class?: string;
	identifier?: string;
	disabled?: boolean;
	isActive?: boolean;
	loading?: boolean;
	onclick?: () => void;
	children?: import('svelte').Snippet;
	[key: string]: unknown;
}

const {
	class: className = undefined,
	identifier,
	disabled = false,
	isActive = false,
	loading = false,
	onclick,
	children,
	...restProps
}: Props = $props();
</script>

<button
	id={identifier ? `nav-sheet-${identifier}` : undefined}
	aria-busy={loading}
	aria-disabled={disabled || loading}
	class={cn(
		'group relative w-full cursor-pointer rounded-lg px-4 py-3 text-left transition-colors duration-200',
		'hover:bg-accent focus-visible:bg-accent/60',
		'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
		isActive
			? 'bg-accent text-primary border-border/30 border font-medium shadow-sm'
			: 'text-foreground/80 hover:text-foreground font-medium',
		disabled && 'pointer-events-none opacity-60',
		className,
	)}
	{disabled}
	{onclick}
	{...restProps}
>
	{#if isActive}
		<div
			class="bg-primary absolute top-1/2 left-0 h-8 w-1 -translate-y-1/2 rounded-r-full"
		></div>
	{/if}

	<div class={cn('relative block pl-3', isActive && 'pl-4')}>
		<span
			class={cn(
				'transition-colors duration-200',
				isActive && 'font-semibold tracking-wide group-hover:text-primary/90',
			)}
		>
			{#if children}
				{@render children()}
			{/if}
		</span>
	</div>

	<!-- Loading state overlay -->
	{#if loading}
		<div
			class="bg-background/80 absolute inset-0 flex items-center justify-center rounded-lg backdrop-blur-[2px]"
		>
			<div
				class="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
			></div>
		</div>
	{/if}
</button>
