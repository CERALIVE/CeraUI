<script lang="ts">
import { Drawer as DrawerPrimitive } from 'vaul-svelte';

let { ref = $bindable(null), ...restProps }: DrawerPrimitive.TriggerProps = $props();
</script>

<DrawerPrimitive.Trigger data-slot="drawer-trigger" bind:ref {...restProps} />
