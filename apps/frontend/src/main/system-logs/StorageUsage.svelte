<!--
  StorageUsage.svelte: what stored logs use: the journal against its limit,
  journal data journalctl does not count, the oldest entry, the event history,
  and recent volume by source labelled as the sample it is. An unknown value
  says so and is never drawn as zero. Bars are neutral and decorative; the text
  beside each carries the number.
-->
<script lang="ts">
import { formatBytes } from '@ceraui/i18n/formatters';
import { getLocale, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { LogStorage } from '@ceraui/rpc/schemas';

import { m } from '$lib/device-logs/storage-messages';
import { keepWhole, onDiskTotal, usageReadout, volumeRows } from '$lib/device-logs/storage-readout';
import { formatUpdateTime } from '$lib/updates/update-view';

let { storage }: { storage: LogStorage } = $props();

const uid = $props.id();
const locale = $derived(getLocale());
const bytes = $derived((value: number) => keepWhole(formatBytes(locale)(value)));
const usage = $derived(usageReadout(storage));
const onDisk = $derived(onDiskTotal(storage));
const oldest = $derived(keepWhole(formatUpdateTime(storage.oldestEntryTs, locale)));
const cleared = $derived(keepWhole(formatUpdateTime(storage.lastClearedAt, locale)));
const rows = $derived(volumeRows(storage.recentVolume));
</script>

{#snippet meter(percent: number, testid: string)}
	<span aria-hidden="true" class="bg-muted block h-1.5 min-w-0 grow overflow-hidden rounded-full" data-testid={testid}>
		<!-- A share under 1 % still draws a sliver; only a zero share leaves the track empty. -->
		<span class={['bg-status-neutral block h-full rounded-full', percent > 0 && 'min-w-1']} style:width="{percent}%"></span>
	</span>
{/snippet}

<div class="flex flex-col gap-5" data-testid="storage-usage">
	<div class="flex flex-col gap-2">
		<p
			class="text-sm tabular-nums"
			data-state={usage.used === null ? 'unknown' : 'reported'}
			data-testid="storage-usage-text"
		>
			{#if usage.used === null}
				{m['systemLogs.storage.notReported']()}
			{:else if usage.limit === null}
				{m['systemLogs.storage.usedNoLimit']({ used: bytes(usage.used) })}
			{:else}
				{m['systemLogs.storage.used']({ used: bytes(usage.used), limit: bytes(usage.limit) })}
			{/if}
		</p>
		{#if usage.percent !== null}
			{@render meter(usage.percent, 'storage-usage-meter')}
		{/if}
		{#if onDisk !== null}
			<p class="text-muted-foreground text-xs" data-testid="storage-on-disk">
				{m['systemLogs.storage.onDisk']({ total: bytes(onDisk) })}
			</p>
		{/if}
	</div>

	<div class="text-muted-foreground flex flex-col gap-1 text-xs">
		<p data-state={oldest === undefined ? 'unknown' : 'reported'} data-testid="storage-oldest">
			{oldest === undefined ? m['systemLogs.storage.oldestUnknown']() : m['systemLogs.storage.oldest']({ date: oldest })}
		</p>
		<p data-testid="storage-events">{m['systemLogs.storage.events']({ size: bytes(storage.eventsBytes) })}</p>
		{#if cleared !== undefined}
			<p data-testid="storage-last-cleared">{m['systemLogs.storage.lastCleared']({ time: cleared })}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-2" data-testid="storage-volume">
		<div>
			<p class="text-sm font-medium" id="{uid}-volume">{m['systemLogs.storage.volumeHeading']()}</p>
			<p class="text-muted-foreground text-xs">
				{m['systemLogs.storage.volumeSample']({ count: storage.recentSample.toLocaleString(locale) })}
			</p>
		</div>
		{#if rows.length > 0}
			<table aria-labelledby="{uid}-volume" class="w-full text-xs">
				<thead class="text-muted-foreground">
					<tr>
						<th class="pe-2 pb-1 text-start font-normal" scope="col">{m['systemLogs.storage.volumeSource']()}</th>
						<th class="pe-2 pb-1 text-end font-normal" scope="col">{m['systemLogs.storage.volumeEntries']()}</th>
						<th class="w-2/5 pb-1 text-end font-normal" scope="col">{m['systemLogs.storage.volumeSize']()}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as row (row.source)}
						<tr data-testid="storage-volume-row">
							<th class="py-1.5 pe-2 text-start font-normal" scope="row">
								{resolveMessageKey(`systemLogs.source.${row.source ?? 'other'}`)}
							</th>
							<td class="py-1.5 pe-2 text-end tabular-nums">{row.entries.toLocaleString(locale)}</td>
							<td class="py-1.5">
								<span class="flex items-center gap-2">
									{@render meter(row.share, 'storage-volume-meter')}
									<span class="w-14 shrink-0 text-end tabular-nums">{bytes(row.bytes)}</span>
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
