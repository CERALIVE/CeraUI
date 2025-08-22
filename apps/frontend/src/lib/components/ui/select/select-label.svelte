<script lang="ts">
import { cn } from '$lib/utils.js';

type $$Props = {
	class?: string;
};

let className: $$Props['class'] = undefined;
export { className as class };
</script>

<div class={cn('px-2 py-1.5 text-sm font-semibold', className)} {...$$restProps}>
	<slot />
</div>
