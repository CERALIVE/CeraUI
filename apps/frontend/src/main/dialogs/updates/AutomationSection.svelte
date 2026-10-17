<!--
  AutomationSection.svelte — when, and from which channel, the device updates
  itself (Todo 41).

  Every control is PESSIMISTIC, in the ModemCapabilitiesDialog shape: a switch or
  a channel rung shows what the DEVICE persisted (`settings`, which the dialog
  replaces only with the `setUpdateSettings` echo), never what was clicked. The
  schedule is the one draft in this section, because two times and a midnight
  flag are edited together and are only valid together: it is checked by the
  shared `validateSchedule` rule and saved with its own button.

  The draft re-seeds only when the APPLIED schedule changes value, not when the
  settings object is replaced by an unrelated save — toggling automatic
  packages must not throw away a window the operator is halfway through typing.

  Package automation works on every image, so it always renders. The system
  image toggle and the channel exist only where the image has an OS agent.

  Both choices are bits-ui radio groups: one tab stop, arrow keys move and
  select (C-m3). While a write is in flight they turn READ-ONLY rather than
  disabled, so a keyboard user's focus is not thrown out of the group by the
  very save their arrow key started. In touch mode the time inputs reach the
  44 px target and the midnight checkbox grows its hit area, not its paint.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateSettings } from '@ceraui/rpc/schemas';
import { RadioGroup } from 'bits-ui';
import { untrack } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { Checkbox } from '$lib/components/ui/checkbox';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import {
	type ScheduleDraft,
	scheduleDraftDirty,
	scheduleDraftFrom,
	scheduleErrorKey,
	scheduleFromDraft,
	validateSchedule,
} from '$lib/updates/update-view';
import { cn } from '$lib/utils';

interface Props {
	settings: UpdateSettings;
	/** The image has an OS agent: show the system toggle and the channel. */
	system: boolean;
	saving: boolean;
	onSave: (patch: Partial<UpdateSettings>) => Promise<boolean>;
}

let { settings, system, saving, onSave }: Props = $props();

const applied = $derived(settings.schedule);
const appliedKey = $derived(`${applied.mode}|${applied.start}|${applied.end}`);
let draft = $derived.by<ScheduleDraft>(() => {
	void appliedKey;
	return untrack(() => scheduleDraftFrom(settings.schedule));
});

const scheduleError = $derived(validateSchedule(draft));
const dirty = $derived(scheduleDraftDirty(draft, applied));

function setDraft(patch: Partial<ScheduleDraft>) {
	draft = { ...draft, ...patch };
}

async function saveSchedule() {
	if (scheduleError !== undefined || !dirty) return;
	await onSave({ schedule: scheduleFromDraft(draft) });
}

const MODES = ['any-idle', 'window'] as const;
const CHANNELS = ['stable', 'beta'] as const;

const MODE_LABEL: Record<(typeof MODES)[number], () => string> = {
	'any-idle': () => m['settings.updates.schedule.anyIdle'](),
	window: () => m['settings.updates.schedule.window'](),
};
const CHANNEL_LABEL: Record<(typeof CHANNELS)[number], () => string> = {
	stable: () => m['settings.updates.channel.stable'](),
	beta: () => m['settings.updates.channel.beta'](),
};

function selectMode(value: string) {
	const mode = MODES.find((candidate) => candidate === value);
	if (mode !== undefined) setDraft({ mode });
}

function selectChannel(value: string) {
	const channel = CHANNELS.find((candidate) => candidate === value);
	if (channel !== undefined && channel !== settings.channel) void onSave({ channel });
}

const rung =
	'flex w-full min-h-[var(--touch-target-min)] items-center gap-2.5 px-3 py-2.5 text-start text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 data-readonly:cursor-not-allowed data-readonly:opacity-60';
</script>

{#snippet pip(selected: boolean)}
	<span
		aria-hidden="true"
		class={cn(
			'size-2.5 shrink-0 rounded-full border',
			selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
		)}
	></span>
{/snippet}

<section aria-labelledby="updates-automation-heading" class="space-y-2.5" data-testid="updates-automation">
	<h3 class="text-sm font-semibold" id="updates-automation-heading">
		{m['settings.updates.automation.title']()}
	</h3>

	<div class="divide-border divide-y overflow-hidden rounded-lg border">
		<div class="flex items-center justify-between gap-4 px-4 py-3">
			<p class="min-w-0 text-sm font-medium">{m['settings.updates.automation.packages']()}</p>
			<Switch
				aria-label={m['settings.updates.automation.packages']()}
				bind:checked={() => settings.packagesAuto, (next) => void onSave({ packagesAuto: next })}
				data-testid="update-auto-packages"
				disabled={saving}
			/>
		</div>
		{#if system}
			<div class="flex items-center justify-between gap-4 px-4 py-3">
				<div class="min-w-0">
					<p class="text-sm font-medium">{m['settings.updates.automation.system']()}</p>
					<p class="text-muted-foreground mt-0.5 text-xs">{m['settings.updates.automation.systemHint']()}</p>
				</div>
				<Switch
					aria-label={m['settings.updates.automation.system']()}
					bind:checked={() => settings.systemAuto, (next) => void onSave({ systemAuto: next })}
					data-testid="update-auto-system"
					disabled={saving}
				/>
			</div>
		{/if}
	</div>
	<p class="text-muted-foreground px-1 text-xs">{m['settings.updates.automation.idleHint']()}</p>

	<div class="space-y-2 pt-1" data-testid="update-schedule">
		<p class="text-sm font-medium" id="updates-schedule-label">{m['settings.updates.schedule.title']()}</p>
		<RadioGroup.Root
			aria-labelledby="updates-schedule-label"
			bind:value={() => draft.mode, selectMode}
			class="divide-border bg-muted/40 divide-y overflow-hidden rounded-lg border"
			data-testid="update-schedule-mode"
			readonly={saving}
		>
			{#each MODES as mode (mode)}
				<RadioGroup.Item
					class={cn(rung, draft.mode === mode ? 'bg-primary/10 text-foreground' : 'hover:bg-accent/50')}
					data-testid={`update-schedule-mode-${mode}`}
					value={mode}
				>
					{#snippet children({ checked })}
						{@render pip(checked)}
						{MODE_LABEL[mode]()}
					{/snippet}
				</RadioGroup.Item>
			{/each}
		</RadioGroup.Root>

		{#if draft.mode === 'window'}
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label for="update-schedule-start">{m['settings.updates.schedule.start']()}</Label>
					<Input
						aria-invalid={scheduleError !== undefined}
						class="min-h-[var(--touch-target-min)]"
						data-testid="update-schedule-start"
						dir="ltr"
						id="update-schedule-start"
						oninput={(event) => setDraft({ start: event.currentTarget.value })}
						type="time"
						value={draft.start}
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="update-schedule-end">{m['settings.updates.schedule.end']()}</Label>
					<Input
						aria-invalid={scheduleError !== undefined}
						class="min-h-[var(--touch-target-min)]"
						data-testid="update-schedule-end"
						dir="ltr"
						id="update-schedule-end"
						oninput={(event) => setDraft({ end: event.currentTarget.value })}
						type="time"
						value={draft.end}
					/>
				</div>
			</div>
			<div class="flex min-h-[var(--touch-target-min)] items-center gap-2.5">
				<Checkbox
					checked={draft.crossesMidnight}
					data-testid="update-schedule-midnight"
					data-touch-target="hit-area"
					id="update-schedule-midnight"
					onCheckedChange={(next) => setDraft({ crossesMidnight: next === true })}
				/>
				<Label class="font-normal" for="update-schedule-midnight">
					{m['settings.updates.schedule.crossesMidnight']()}
				</Label>
			</div>
		{/if}

		{#if scheduleError}
			<p
				class="text-status-warning text-sm"
				data-error={scheduleError}
				data-testid="update-schedule-error"
				role="alert"
			>
				{resolveMessageKey(scheduleErrorKey(scheduleError))}
			</p>
		{/if}

		{#if dirty}
			<Button
				class="w-full"
				data-testid="update-schedule-save"
				disabled={saving || scheduleError !== undefined}
				onclick={saveSchedule}
				variant="outline"
			>
				{m['settings.updates.schedule.save']()}
			</Button>
		{/if}
	</div>

	{#if system}
		<div class="space-y-2 pt-1" data-testid="update-channel">
			<p class="text-sm font-medium" id="updates-channel-label">{m['settings.updates.channel.title']()}</p>
			<RadioGroup.Root
				aria-labelledby="updates-channel-label"
				bind:value={() => settings.channel, selectChannel}
				class="divide-border bg-muted/40 divide-y overflow-hidden rounded-lg border"
				data-testid="update-channel-options"
				readonly={saving}
			>
				{#each CHANNELS as channel (channel)}
					<RadioGroup.Item
						class={cn(rung, settings.channel === channel ? 'bg-primary/10 text-foreground' : 'hover:bg-accent/50')}
						data-testid={`update-channel-${channel}`}
						value={channel}
					>
						{#snippet children({ checked })}
							{@render pip(checked)}
							{CHANNEL_LABEL[channel]()}
						{/snippet}
					</RadioGroup.Item>
				{/each}
			</RadioGroup.Root>
			<p class="text-muted-foreground px-1 text-xs">{m['settings.updates.channel.hint']()}</p>
		</div>
	{/if}
</section>
