<script lang="ts">
import { Avatar as AvatarPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: AvatarPrimitive.FallbackProps = $props();
</script>

<AvatarPrimitive.Fallback
	class={cn(
		'bg-muted text-muted-foreground flex size-full items-center justify-center rounded-full text-sm group-data-[size=sm]/avatar:text-xs',
		className,
	)}
	data-slot="avatar-fallback"
	bind:ref
	{...restProps}
/>
