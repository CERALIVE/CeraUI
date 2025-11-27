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
			toast:
				'group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl',
			description: 'group-[.toast]:text-muted-foreground',
			actionButton:
				'group-[.toast]:bg-gradient-to-r group-[.toast]:from-emerald-500 group-[.toast]:to-teal-600 group-[.toast]:text-white group-[.toast]:rounded-lg group-[.toast]:font-medium',
			cancelButton:
				'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:rounded-lg',
			success:
				'group-[.toaster]:border-emerald-500/30 group-[.toaster]:bg-emerald-50 group-[.toaster]:dark:bg-emerald-950/20',
			error:
				'group-[.toaster]:border-red-500/30 group-[.toaster]:bg-red-50 group-[.toaster]:dark:bg-red-950/20',
			warning:
				'group-[.toaster]:border-amber-500/30 group-[.toaster]:bg-amber-50 group-[.toaster]:dark:bg-amber-950/20',
			info: 'group-[.toaster]:border-blue-500/30 group-[.toaster]:bg-blue-50 group-[.toaster]:dark:bg-blue-950/20',
		},
	}}
	{...restProps}
/>
