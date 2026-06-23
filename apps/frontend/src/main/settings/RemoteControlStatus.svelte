<!--
  RemoteControlStatus.svelte — remote-control channel status row (Task 8).

  A calm, non-interactive status row for the Settings → Streaming group. It is
  deliberately NOT in the HUD (the HUD's 5-signal contract is frozen). It reflects
  the device-control channel's 3-state rollup from the pairing store:
    • not-paired           — no remote_key; pair to manage from the cloud.
    • paired-disconnected  — paired, control channel currently down.
    • connected            — paired, live control channel to the cloud hub.
  Provider-agnostic: the row never assumes CeraLive (multi-cloud safe).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Cloud, CloudOff, RadioTower } from '@lucide/svelte';

import { getRemoteControlStatus } from '$lib/stores/pairing.svelte';

const status = $derived(getRemoteControlStatus());
const t = $derived($LL.settings.remoteControl);

const label = $derived(
	status === 'connected'
		? t.connected()
		: status === 'paired-disconnected'
			? t.disconnected()
			: t.notPaired(),
);
const hint = $derived(
	status === 'connected'
		? t.connectedHint()
		: status === 'paired-disconnected'
			? t.disconnectedHint()
			: t.notPairedHint(),
);
const Icon = $derived(
	status === 'connected' ? RadioTower : status === 'paired-disconnected' ? CloudOff : Cloud,
);
const dotColor = $derived(
	status === 'connected'
		? 'var(--status-success)'
		: status === 'paired-disconnected'
			? 'var(--status-warning)'
			: 'var(--muted-foreground)',
);
</script>

<div
	class="flex w-full items-center gap-4 px-4 py-3.5"
	data-status={status}
	data-testid="remote-control-status"
	role="status"
>
	<span class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
		<Icon class="size-[18px]" />
	</span>
	<span class="min-w-0 flex-1">
		<span class="flex items-center gap-2">
			<span class="size-2 shrink-0 rounded-full" style:background-color={dotColor}></span>
			<span class="block truncate text-sm font-semibold">{label}</span>
		</span>
		<span class="text-muted-foreground block truncate text-xs">{hint}</span>
	</span>
</div>
