<!--
  StorageLimits.svelte: how long and how much the device keeps, and at what
  detail. Choices are staged and only Save applies them, because a tighter
  limit deletes stored logs. Every offered limit stays inside the device's own
  ceiling; when the device does not report it, both limits stay visible but
  disabled with the reason beside them, and only Detail can change. After Save
  it states what the cleanup that this Save ran achieved.
-->
<script lang="ts">
import { formatBytes } from '@ceraui/i18n/formatters';
import { getLocale } from '@ceraui/i18n/svelte';
import type { LogRetention, LogStorage } from '@ceraui/rpc/schemas';
import { untrack } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import {
	keepForOptions,
	limitFromValue,
	limitValue,
	maxSizeOptions,
	retentionDraft,
	sameRetention,
} from '$lib/device-logs/storage-limits';
import { m } from '$lib/device-logs/storage-messages';
import { type SaveNote, saveNote, settleAction, storageReply } from '$lib/device-logs/storage-outcome';
import { keepWhole, LINE_BREAKS } from '$lib/device-logs/storage-readout';
import { rpc } from '$lib/rpc/client';
import { formatDayCount } from '$lib/updates/credential-expiry';

import RecoveryBand from './RecoveryBand.svelte';

let { storage = $bindable() }: { storage: LogStorage } = $props();

const MIB = 1024 * 1024;
const DETAILS = [
	{
		value: 'debug',
		label: () => m['systemLogs.storage.detailFull'](),
		hint: () => m['systemLogs.storage.detailFullHint'](),
	},
	{
		value: 'info',
		label: () => m['systemLogs.storage.detailReduced'](),
		hint: () => m['systemLogs.storage.detailReducedHint'](),
	},
] as const;

const uid = $props.id();
const locale = $derived(getLocale());
const bytes = $derived((value: number) => keepWhole(formatBytes(locale)(value)));
const ceiling = $derived(storage.ceiling);
const saved = $derived(retentionDraft(storage));
const unknown = $derived(m['systemLogs.versions.notReported']());

let draft = $state(untrack(() => retentionDraft(storage)));
let saving = $state(false);
let outcome = $state<SaveNote | 'failed'>();

const dirty = $derived(!sameRetention(draft, saved));
const limits = $derived([
	{
		key: 'maxAgeDays',
		label: m['systemLogs.storage.keepForLabel'](),
		options: ceiling === null ? [] : keepForOptions(ceiling.maxAgeDays),
		describe: (days: number | null) =>
			days === null
				? m['systemLogs.storage.keepForDevice']({
						value: ceiling === null ? unknown : keepWhole(formatDayCount(ceiling.maxAgeDays, locale)),
					})
				: m['systemLogs.storage.keepForDays']({ count: days }),
	},
	{
		key: 'maxSizeMb',
		label: m['systemLogs.storage.maxSizeLabel'](),
		options: ceiling === null ? [] : maxSizeOptions(ceiling.maxSizeMb),
		describe: (mb: number | null) =>
			mb === null
				? m['systemLogs.storage.maxSizeDevice']({
						value: ceiling === null ? unknown : bytes(ceiling.maxSizeMb * MIB),
					})
				: bytes(mb * MIB),
	},
] as const);

function stage(patch: Partial<LogRetention>): void {
	draft = { ...draft, ...patch };
	outcome = undefined;
}

async function save(): Promise<void> {
	const before = storage.lastMaintenance;
	saving = true;
	outcome = undefined;
	const reply = await settleAction(() => rpc.logs.setRetention(draft), storageReply);
	saving = false;
	if (typeof reply === 'string') {
		outcome = 'failed';
		return;
	}
	storage = reply.storage;
	draft = retentionDraft(reply.storage);
	outcome = saveNote(before, reply.storage.lastMaintenance);
}
</script>

<fieldset class="min-w-0" data-testid="storage-limits">
	<legend class="text-sm font-medium">{m['systemLogs.storage.limitsHeading']()}</legend>
	<div class="mt-3 flex flex-col gap-4">
		{#each limits as limit (limit.key)}
			<div class="flex flex-col gap-1.5">
				<Label class="text-muted-foreground text-xs" for="{uid}-{limit.key}">{limit.label}</Label>
				<Select.Root
					disabled={ceiling === null}
					onValueChange={(value) => stage({ [limit.key]: limitFromValue(value) })}
					type="single"
					value={limitValue(draft[limit.key])}
				>
					<Select.Trigger
						aria-describedby={ceiling === null ? `${uid}-reason` : undefined}
						class="w-full whitespace-normal py-1.5 text-start data-[size=default]:h-auto"
						data-testid="storage-{limit.key}-select"
						id="{uid}-{limit.key}"
					>
						{limit.describe(draft[limit.key])}
					</Select.Trigger>
					<Select.Content class={LINE_BREAKS}>
						{#each [null, ...limit.options] as option (option)}
							<Select.Item class="min-h-(--touch-target-min)" label={limit.describe(option)} value={limitValue(option)} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		{/each}
		{#if ceiling === null}
			<p class="text-muted-foreground text-xs" data-testid="storage-limits-reason" id="{uid}-reason">
				{m['systemLogs.storage.limitsUnknown']()}
			</p>
		{/if}

		<fieldset class="min-w-0">
			<legend class="text-muted-foreground mb-1.5 text-xs">{m['systemLogs.storage.detailLabel']()}</legend>
			<div class="flex flex-col gap-2">
				{#each DETAILS as option (option.value)}
					<label
						class="has-checked:bg-muted flex min-h-(--touch-target-min) cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5"
					>
						<input
							aria-describedby="{uid}-{option.value}-hint"
							aria-labelledby="{uid}-{option.value}"
							checked={draft.detail === option.value}
							class="accent-foreground mt-0.5 size-4 shrink-0"
							data-testid="storage-detail-{option.value}"
							name="{uid}-detail"
							onchange={() => stage({ detail: option.value })}
							type="radio"
							value={option.value}
						/>
						<span class="flex flex-col gap-0.5">
							<span class="text-sm font-medium" id="{uid}-{option.value}">{option.label()}</span>
							<span class="text-muted-foreground text-xs" id="{uid}-{option.value}-hint">{option.hint()}</span>
						</span>
					</label>
				{/each}
			</div>
		</fieldset>

		<div class="flex flex-col items-start gap-2">
			<Button aria-busy={saving} data-testid="storage-save" disabled={!dirty || saving} onclick={save}>
				{m['systemLogs.storage.save']()}
			</Button>
			<div class="text-sm" data-testid="storage-save-status" role="status">
				{#if outcome === 'saved' || outcome === 'targetNotMet'}
					<p>{m['systemLogs.storage.saved']()}</p>
				{/if}
				{#if outcome === 'targetNotMet'}
					<p class="text-muted-foreground">{m['systemLogs.storage.targetNotMet']()}</p>
				{/if}
			</div>
		</div>
		{#if outcome === 'failed' || outcome === 'maintenanceFailed'}
			<RecoveryBand
				message={outcome === 'failed'
					? m['systemLogs.storage.actionFailed']()
					: m['systemLogs.storage.maintenanceFailed']()}
				onretry={save}
				testid="storage-save-failed"
			/>
		{/if}
	</div>
</fieldset>
