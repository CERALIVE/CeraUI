<!--
  BootPicker.svelte — the boot list of System Logs: All boots, then every boot
  the device reports, in its order (newest first), each with its start time, how
  it ended (the device's own mark), its system image and slot, "Changed" when
  those differ from the boot before it, and "Logs removed" when its raw logs are
  gone; such boots stay listed. Choosing one sets the boot of both tabs through
  bootSelection. The list is one tab stop: arrows, Home and End move focus,
  Enter or Space chooses. It re-reads the boots when stored history is deleted.
  Its copy breaks Korean only between words and Japanese only between phrases,
  a start time never inside a token (16日, 오전), and only the recorded
  version values (in their <bdi>) may break anywhere.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import type { LogBootInfo } from '@ceraui/rpc/schemas';
import { Check, RefreshCw, TriangleAlert } from '@lucide/svelte';
import { onDestroy } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { BootList } from '$lib/device-logs/boot-list.svelte';
import { bootRows, formatBootTime, pickerKeyTarget } from '$lib/device-logs/boot-rows';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { rpc } from '$lib/rpc/client';

import ParamText from './ParamText.svelte';
import ShutdownMark from './ShutdownMark.svelte';

let { onchoose }: { onchoose?: () => void } = $props();

const OPTION =
	'flex min-h-(--touch-target-min) cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-start outline-none hover:bg-muted/60 aria-selected:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50';
const TAG = 'bg-secondary text-secondary-foreground rounded-sm px-1.5 py-0.5 font-medium';

const uid = $props.id();
const list = new BootList(() => rpc.logs.boots());
void list.load();
onDestroy(onHistoryChanged(() => void list.load()));

let listbox = $state<HTMLElement>();
const rows = $derived(list.boots === null ? null : bootRows(list.boots));
const selectedId = $derived(bootSelection.bootId);
// The single tab stop: the chosen boot, or All boots when that boot is not listed.
const stopId = $derived(rows?.some((row) => row.boot.bootId === selectedId) ? selectedId : null);

function choose(boot: LogBootInfo | null): void {
	bootSelection.choose(boot);
	onchoose?.();
}

// `target` is where an arrow, Home or End key moves focus; Enter or Space chooses.
function keydown(event: KeyboardEvent, target: number | undefined, boot: LogBootInfo | null): void {
	const chooses = event.key === 'Enter' || event.key === ' ';
	if (target === undefined && !chooses) return;
	event.preventDefault();
	if (target === undefined) choose(boot);
	else listbox?.querySelectorAll<HTMLElement>('[role="option"]')[target]?.focus();
}
</script>

{#snippet check(selected: boolean)}
	<span class="ms-auto flex size-4 shrink-0" data-check-slot>
		{#if selected}
			<Check class="text-foreground size-4" data-selected-check />
		{/if}
	</span>
{/snippet}

<div class="flex flex-col gap-3 [word-break:auto-phrase] [&:lang(ko)]:break-keep" data-testid="boot-picker">
	{#if list.failed}
		<div
			class="border-status-warning/30 bg-status-warning/10 flex flex-col gap-3 rounded-lg border p-3"
			data-testid="boot-picker-failed"
			role="alert"
		>
			<div class="flex items-start gap-2">
				<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" />
				<p class="text-sm">{m['systemLogs.boots.loadFailed']()}</p>
			</div>
			<Button
				class="gap-1.5 self-start"
				data-testid="boot-picker-retry"
				onclick={() => void list.load()}
				size="sm"
				variant="outline"
			>
				<RefreshCw class="size-4" />
				{m['systemLogs.action.retry']()}
			</Button>
		</div>
	{/if}

	{#if rows !== null}
		<span hidden id="{uid}-changed">{m['systemLogs.boots.changedDescription']()}</span>
		<div aria-label={m['systemLogs.boots.heading']()} bind:this={listbox} class="flex flex-col gap-2" role="listbox">
			<div
				aria-selected={selectedId === null}
				class={OPTION}
				data-testid="boot-option-all"
				onclick={() => choose(null)}
				onkeydown={(event) => keydown(event, pickerKeyTarget(event.key, 0, rows.length + 1), null)}
				role="option"
				tabindex={stopId === null ? 0 : -1}
			>
				<span class="text-sm font-medium">{m['systemLogs.boots.all']()}</span>
				{@render check(selectedId === null)}
			</div>
			{#each rows as row, index (row.boot.bootId)}
				<div
					aria-describedby={row.changed ? `${uid}-changed` : undefined}
					aria-selected={row.boot.bootId === selectedId}
					class={OPTION}
					data-boot-id={row.boot.bootId}
					data-state={row.boot.shutdown}
					data-testid="boot-option"
					onclick={() => choose(row.boot)}
					onkeydown={(event) => keydown(event, pickerKeyTarget(event.key, index + 1, rows.length + 1), row.boot)}
					role="option"
					tabindex={stopId === row.boot.bootId ? 0 : -1}
				>
					<span class="flex min-w-0 flex-1 flex-col gap-1">
						<time class="text-sm font-medium text-pretty tabular-nums break-keep" datetime={new Date(row.boot.firstTs).toISOString()}>
							<ParamText
								format={(time) => m['systemLogs.boots.started']({ time })}
								value={formatBootTime(row.boot.firstTs, getLocale())}
							/>
						</time>
						<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
							<ShutdownMark shutdown={row.boot.shutdown} />
							<span class="text-muted-foreground flex flex-wrap gap-x-2 [&_bdi]:wrap-anywhere" data-testid="boot-versions">
								{#if row.osImage === null && row.slot === null}
									<span>{m['systemLogs.boots.versionsUnknown']()}</span>
								{:else}
									{#if row.osImage !== null}
										<span>
											<ParamText format={(version) => m['systemLogs.boots.systemImage']({ version })} value={row.osImage} />
										</span>
									{/if}
									{#if row.slot !== null}
										<span><ParamText format={(slot) => m['systemLogs.boots.slot']({ slot })} value={row.slot} /></span>
									{/if}
								{/if}
							</span>
						</span>
						{#if row.changed || !row.boot.logsAvailable}
							<span class="flex flex-wrap items-center gap-2 text-xs">
								{#if row.changed}
									<span class={TAG} data-testid="boot-changed">{m['systemLogs.boots.changed']()}</span>
								{/if}
								{#if !row.boot.logsAvailable}
									<span class={TAG} data-testid="boot-logs-removed">{m['systemLogs.boots.logsRemoved']()}</span>
								{/if}
							</span>
						{/if}
					</span>
					{@render check(row.boot.bootId === selectedId)}
				</div>
			{/each}
		</div>
		{#if rows.every((row) => row.boot.current)}
			<p class="text-muted-foreground px-3 text-xs" data-testid="boot-picker-empty">{m['systemLogs.boots.empty']()}</p>
		{/if}
	{:else if !list.failed}
		<div aria-busy="true" class="flex flex-col gap-2" data-testid="boot-picker-loading" role="status">
			<span class="sr-only">{m['common.loading']()}</span>
			{#each [0, 1, 2] as row (row)}
				<div class="flex flex-col gap-1.5 px-3 py-2">
					<Skeleton class="h-4 w-3/4" />
					<div class="flex items-center gap-1.5">
						<Skeleton class="size-4 shrink-0 rounded-full" />
						<Skeleton class="h-3 w-1/2" />
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
