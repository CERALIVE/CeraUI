<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';

import { Skeleton } from '$lib/components/ui/skeleton';
import type { BootList } from '$lib/device-logs/boot-list.svelte';
import { type BootRow, formatBootTime } from '$lib/device-logs/boot-rows';

import ParamText from './ParamText.svelte';
import ShutdownMark from './ShutdownMark.svelte';

let { id, info, boots }: { id: string; info: BootRow | undefined; boots: BootList } = $props();
</script>

<h3 class="bg-muted sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-y px-4 py-2 text-xs" {id}>
	{#if info !== undefined}
		<time class="text-sm font-medium tabular-nums" datetime={new Date(info.boot.firstTs).toISOString()}
			><ParamText
				format={(time) => m['systemLogs.boots.started']({ time })}
				value={formatBootTime(info.boot.firstTs, getLocale())}
			/></time
		>
		<span class="text-muted-foreground flex flex-wrap gap-x-2">
			{#if info.osImage === null && info.slot === null}
				<span>{m['systemLogs.boots.versionsUnknown']()}</span>
			{:else}
				{#if info.osImage !== null}
					<span><ParamText format={(version) => m['systemLogs.boots.systemImage']({ version })} value={info.osImage} /></span>
				{/if}
				{#if info.slot !== null}
					<span><ParamText format={(slot) => m['systemLogs.boots.slot']({ slot })} value={info.slot} /></span>
				{/if}
			{/if}
		</span>
		<ShutdownMark shutdown={info.boot.shutdown} />
		{#if info.changed}
			<span class="bg-secondary text-secondary-foreground rounded-sm px-1.5 py-0.5 font-medium">{m['systemLogs.boots.changed']()}</span>
		{/if}
	{:else if boots.failed}
		<span class="text-sm font-medium">{m['systemLogs.boots.loadFailed']()}</span>
	{:else if boots.boots === null}
		<span class="sr-only">{m['common.loading']()}</span>
		<Skeleton class="h-4 w-48" />
	{:else}
		<span class="text-sm font-medium">{m['systemLogs.boots.versionsUnknown']()}</span>
	{/if}
</h3>
