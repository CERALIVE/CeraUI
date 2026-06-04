<script lang="ts">
import { Dialog as DialogPrimitive } from 'bits-ui';

let { ref = $bindable(null), type = 'button', ...restProps }: DialogPrimitive.CloseProps = $props();
</script>

<DialogPrimitive.Close data-slot="dialog-close" {type} bind:ref {...restProps} />
