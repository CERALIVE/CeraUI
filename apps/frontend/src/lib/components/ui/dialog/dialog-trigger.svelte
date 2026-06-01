<script lang="ts">
import { Dialog as DialogPrimitive } from 'bits-ui';

let {
	ref = $bindable(null),
	type = 'button',
	...restProps
}: DialogPrimitive.TriggerProps = $props();
</script>

<DialogPrimitive.Trigger data-slot="dialog-trigger" {type} bind:ref {...restProps} />
