<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
import type { Snippet } from 'svelte';

interface Props extends DropdownMenuPrimitive.RadioGroupProps {
	children?: Snippet;
}

let { value = $bindable(), children, ...restProps }: Props = $props();
</script>

<DropdownMenuPrimitive.RadioGroup {children} {...restProps} bind:value />
