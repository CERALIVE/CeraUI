<script lang="ts">
import { Dialog as DialogPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: DialogPrimitive.TitleProps = $props();
</script>

<DialogPrimitive.Title
	class={cn('text-base leading-none font-medium', className)}
	data-slot="dialog-title"
	bind:ref
	{...restProps}
/>
