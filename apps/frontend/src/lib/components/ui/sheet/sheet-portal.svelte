<script lang="ts">
import { Dialog as SheetPrimitive } from 'bits-ui';
import type { Snippet } from 'svelte';

interface Props extends SheetPrimitive.PortalProps {
	class?: string;
	children?: Snippet;
}

let { class: className, children, ...restProps }: Props = $props();
</script>

<SheetPrimitive.Portal {children} {...restProps} />
