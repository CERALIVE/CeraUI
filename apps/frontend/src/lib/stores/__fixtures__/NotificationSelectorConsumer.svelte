<script lang="ts">
import { getActive, getPersistent } from '../notifications.svelte';

const active = $derived(getActive());
const persistent = $derived(getPersistent());
const activeStable = $derived(active === getActive());
const persistentStable = $derived(persistent === getPersistent());
</script>

<div
	data-testid="notification-selector-consumer"
	data-active-stable={activeStable}
	data-persistent-stable={persistentStable}
></div>
