<script lang="ts">
import { Dialog as SheetPrimitive } from 'bits-ui';

type $$Props = {
	class?: string;
};

let className: $$Props['class'] = undefined;
export { className as class };
</script>

<SheetPrimitive.Portal {...$$restProps}>
	<slot />
</SheetPrimitive.Portal>
