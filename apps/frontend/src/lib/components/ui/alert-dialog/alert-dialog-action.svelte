<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

import {
	type ButtonSize,
	type ButtonVariant,
	buttonVariants,
} from '$lib/components/ui/button/index.js';
import { cn } from '$lib/utils.js';

let {
	ref = $bindable(null),
	class: className,
	variant = 'default',
	size = 'default',
	...restProps
}: AlertDialogPrimitive.ActionProps & {
	variant?: ButtonVariant;
	size?: ButtonSize;
} = $props();
</script>

<AlertDialogPrimitive.Action
	class={cn(buttonVariants({ variant, size }), 'cn-alert-dialog-action', className)}
	data-slot="alert-dialog-action"
	bind:ref
	{...restProps}
/>
