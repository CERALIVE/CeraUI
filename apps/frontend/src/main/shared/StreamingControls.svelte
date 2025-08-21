<script lang="ts">
import { Play, Square } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import { Button } from '$lib/components/ui/button';

interface Props {
	isStreaming: boolean;
	onStart: () => void;
	onStop: () => void;
	disabled?: boolean;
}

const { isStreaming, onStart, onStop, disabled = false }: Props = $props();

const handleStart = () => {
	if (!disabled) {
		onStart();
	}
};

const handleStop = () => {
	// Remove problematic toast.dismiss() call that causes Svelte 5 compatibility issues
	// The toast will be handled by the proper streaming stop notifications

	if (window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear();
	} else {
		// Fallback
		import('$lib/helpers/SystemHelper').then((module) => {
			module.stopStreaming();
		});
	}
	onStop();
};
</script>

<div class="bg-background/95 sticky top-0 z-10 border-b p-6 pb-4 backdrop-blur-sm">
	<div class="mx-auto max-w-4xl">
		{#if isStreaming}
			<Button
				class="group w-full bg-orange-600 shadow-lg transition-all duration-200 hover:bg-orange-700"
				onclick={handleStop}
				size="lg"
				type="button"
			>
				<Square class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
				{$_('settings.stopStreaming')}
			</Button>
		{:else}
			<Button
				class="group w-full bg-gradient-to-r from-green-600 to-green-700 shadow-lg transition-all duration-200 hover:from-green-700 hover:to-green-800"
				{disabled}
				onclick={handleStart}
				size="lg"
				type="submit"
			>
				<Play class="mr-2 h-5 w-5 transition-transform group-hover:scale-110" />
				{$_('settings.startStreaming')}
			</Button>
		{/if}

		{#if disabled}
			<p class="text-muted-foreground mt-2 text-center text-sm">
				{$_('settings.completeRequiredFields')}
			</p>
		{/if}
	</div>
</div>
