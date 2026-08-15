<!--
  LowDiskBanner.svelte — calm low-storage warning for the Settings destination.

  Derived from the EXISTING device-stats `disk` signal (no sixth signal): when
  `/data` drops below a fixed 512 MiB free it surfaces a calm amber band pointing
  the operator to the logs (where storage-pressure symptoms first show up). It
  renders nothing while disk is healthy or the signal is unavailable, so a degraded
  source never raises a false alarm.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { HardDrive, ScrollText } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { isDiskLow } from '$lib/helpers/disk-warning';
import { getDeviceStats } from '$lib/rpc/subscriptions.svelte';

interface Props {
	/** Open the Logs dialog — storage symptoms surface there first. */
	onViewLogs: () => void;
}

const { onViewLogs }: Props = $props();

const warn = $derived(isDiskLow(getDeviceStats()?.disk));
</script>

{#if warn}
	<div
		class="border-status-warning/30 bg-status-warning/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center"
		data-testid="low-disk-banner"
		role="status"
	>
		<span
			class="bg-status-warning/15 text-status-warning grid size-9 shrink-0 place-items-center rounded-lg"
		>
			<HardDrive aria-hidden="true" class="size-[18px]" />
		</span>
		<div class="min-w-0 flex-1">
			<p class="text-status-warning text-sm font-semibold">{m["settings.deviceStats.lowDiskTitle"]()}</p>
			<p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">{m["settings.deviceStats.lowDiskBody"]()}</p>
		</div>
		<Button
			class="shrink-0 gap-1.5"
			data-testid="low-disk-view-logs"
			onclick={onViewLogs}
			size="sm"
			variant="outline"
		>
			<ScrollText aria-hidden="true" class="size-4" />
			{m["settings.deviceStats.lowDiskAction"]()}
		</Button>
	</div>
{/if}
