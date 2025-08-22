<script lang="ts">
import { Drawer as DrawerPrimitive } from 'vaul-svelte';

import { cn } from '$lib/utils.js';

import DrawerOverlay from './drawer-overlay.svelte';

let {
	ref = $bindable(null),
	class: className,
	portalProps,
	children,
	...restProps
}: DrawerPrimitive.ContentProps & {
	portalProps?: DrawerPrimitive.PortalProps;
} = $props();
</script>

<DrawerPrimitive.Portal {...portalProps}>
	<DrawerOverlay />
	<DrawerPrimitive.Content
		class={cn(
			'bg-background fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto flex-col rounded-t-[10px] border',
			className,
		)}
		bind:ref
		{...restProps}
	>
		<div class="bg-muted mx-auto mt-4 h-2 w-[100px] rounded-full"></div>
		{@render children?.()}
	</DrawerPrimitive.Content>
</DrawerPrimitive.Portal>
