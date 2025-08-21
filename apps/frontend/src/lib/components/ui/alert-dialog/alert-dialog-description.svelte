<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
	class: className,
	ref = $bindable(null),
	...restProps
}: AlertDialogPrimitive.DescriptionProps = $props();
</script>

<AlertDialogPrimitive.Description
	class={cn('text-muted-foreground text-sm', className)}
	bind:ref
	{...restProps}
/>
