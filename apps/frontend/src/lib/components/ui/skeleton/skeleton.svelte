<script lang="ts">
import type { HTMLAttributes } from 'svelte/elements';

import { cn } from '$lib/utils.js';

interface Props extends HTMLAttributes<HTMLDivElement> {
	class?: string;
}

let { class: className, ...restProps }: Props = $props();
</script>

<div class={cn('bg-primary/10 animate-pulse rounded-md', className)} {...restProps}></div>
