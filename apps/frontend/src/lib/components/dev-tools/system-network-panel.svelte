<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Wifi } from '@lucide/svelte';

type NetworkConnection = {
	effectiveType?: string;
	downlink?: number;
	rtt?: number;
} | null;

let { connection }: { connection: NetworkConnection } = $props();
</script>

<!-- Network Information -->
{#if connection}
	<div class="space-y-3">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Wifi class="h-4 w-4" />
			Network Connection
		</div>
		<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{m["devtools.type"]()}</div>
				<div class="font-mono text-sm font-medium">
					{connection.effectiveType || m["devtools.unknown"]()}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{m["devtools.downlink"]()}</div>
				<div class="font-mono text-sm font-medium">
					{connection.downlink || m["devtools.unknown"]()}
					{m["devtools.mbps"]()}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{m["devtools.rtt"]()}</div>
				<div class="font-mono text-sm font-medium">
					{connection.rtt || m["devtools.unknown"]()}{m["devtools.ms"]()}
				</div>
			</div>
		</div>
	</div>
{/if}
