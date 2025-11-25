<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
import type { Snippet } from 'svelte';

interface Props extends AlertDialogPrimitive.PortalProps {
	children?: Snippet;
}

let { children, ...restProps }: Props = $props();
</script>

<AlertDialogPrimitive.Portal {children} {...restProps} />
