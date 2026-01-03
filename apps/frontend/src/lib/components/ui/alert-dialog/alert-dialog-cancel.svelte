<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

import { buttonVariants } from '$lib/components/ui/button/index.js';
import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: AlertDialogPrimitive.CancelProps = $props();
</script>

<AlertDialogPrimitive.Cancel
	class={cn(buttonVariants({ variant: 'outline' }), className)}
	data-slot="alert-dialog-cancel"
	bind:ref
	{...restProps}
/>
