<script lang="ts">
import { mode } from 'mode-watcher';
import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';

const restProps: SonnerProps = $props();
</script>

<Sonner
	class="toaster group"
	theme={mode.current}
	toastOptions={{
		classes: {
			toast: 'group toast',
			title: 'font-semibold',
			description: 'text-sm',
			actionButton: 'rounded-lg font-medium',
			cancelButton: 'rounded-lg',
		},
	}}
	{...restProps}
/>
