<!--
  OnDeviceDisplaySection.svelte — the On-Device Display settings surface (Task 25).

  The user's entire control surface for the on-device kiosk display (DC-2,
  docs/KIOSK_STATE_MACHINE.md). Composes the shared AppDialog chrome and exposes:
    - enable/disable toggle (kioskStart / kioskStop, pessimistic AsyncSwitch)
    - the LIVE kiosk state (5 DC-2 states), not just the on/off toggle
    - display-profile / touch / reduced-motion / performance (kioskConfigure)
    - on-screen-keyboard show/hide (kioskOsk → wvkbd SIGUSR2/SIGUSR1)

  Live state is seeded once from kioskStatus() on open, then tracks the backend
  `kiosk` broadcast (getKiosk) so a crash-loop auto-disable (T5) reflects without
  a refresh. The toggle binds to the persisted `enabled`; the indicator reads the
  live `state` — so a failed unit never reads as "running".
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	KIOSK_UNAVAILABLE_ERROR,
	kioskDisplaySchema,
	type KioskConfigureInput,
	type KioskDisplay,
	type KioskPerformance,
	type KioskState,
	kioskPerformanceSchema,
} from '@ceraui/rpc/schemas';
import { Keyboard, KeyboardOff, LoaderCircle, Monitor } from '@lucide/svelte';
import { onMount } from 'svelte';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import {
	clearOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getKiosk } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = $derived($LL.settings.onDeviceDisplay);

// Option lists sourced from the contract enums (no inline string literals).
const displayOptions = kioskDisplaySchema.options;
const performanceOptions = kioskPerformanceSchema.options;

// Persisted toggle + live state + display profile. Seeded once on open from
// kioskStatus(), then reconciled from the `kiosk` broadcast (getKiosk).
let enabled = $state(false);
let liveState = $state<KioskState>('disabled');
let display = $state<KioskDisplay>('lcd');
let touch = $state(true);
let motion = $state(true);
let performance = $state<KioskPerformance>('balanced');
let loaded = $state(false);

// In-flight + re-entry state for the on-screen-keyboard signal, derived from the
// keyed async-operation machine (osCommand) rather than a hand-rolled boolean.
const oskBusy = $derived(getOperationPhase('kiosk-osk') === 'pending');

// Set when the backend reports the kiosk is unavailable in emulated mode (T13):
// surfaces a calm banner instead of an error toast, and the toggle reverts.
let unavailable = $state(false);

// Reconcile from the authoritative broadcast whenever it changes. Never calls
// kioskStart on its own, so a headless unit stays disabled by default (DC-2).
$effect(() => {
	const live = getKiosk();
	if (!live) return;
	enabled = live.enabled;
	liveState = live.state;
	display = live.display;
	touch = live.touch;
	motion = live.motion;
	performance = live.performance;
	loaded = true;
});

onMount(async () => {
	try {
		const status = await rpc.system.kioskStatus();
		enabled = status.enabled;
		liveState = status.state;
		display = status.display;
		touch = status.touch;
		motion = status.motion;
		performance = status.performance;
	} catch (error) {
		console.error('Failed to load kiosk status:', error);
	} finally {
		loaded = true;
	}
});

// The enable/disable toggle is a G4 status op — it routes through the keyed
// async-operation machine (osCommand), which owns the re-entry guard + in-flight
// `pending` phase. `classify` keeps EVERY resolved verdict `ok` so osCommand never
// toasts here: the emulated-mode "unavailable" outcome is surfaced as a calm
// banner (not an error toast), and a genuine RPC throw is the only case that
// toasts (via `failMessage`). On any non-applied outcome we reject so the
// pessimistic AsyncSwitch reverts to the prior value.
async function handleEnableChange(next: boolean) {
	const result = await osCommand({
		key: 'kiosk',
		target: next,
		rpc: () => (next ? rpc.system.kioskStart() : rpc.system.kioskStop()),
		confirmOnResolve: true,
		classify: () => ({ ok: true }),
		failMessage: () => t.toggleError(),
	});
	// undefined → re-entry no-op or a thrown RPC (osCommand already toasted).
	if (!result) throw new Error('kiosk_toggle_failed');
	if (result.error === KIOSK_UNAVAILABLE_ERROR || !result.applied) {
		unavailable = true;
		// The op did not actually apply — drop the (optimistically confirmed)
		// async-op entry so it never reads as a real success.
		clearOperation('kiosk');
		// Reject so AsyncSwitch reverts to the prior value without an error toast.
		throw new Error(KIOSK_UNAVAILABLE_ERROR);
	}
	unavailable = false;
	enabled = result.applied.enabled;
	liveState = result.applied.state;
}

// kioskConfigure routes through the keyed async-operation machine (key
// 'kiosk-configure') for the re-entry guard + in-flight phase. As with the
// toggle, `classify` keeps every resolved verdict `ok` so the calm emulated-mode
// banner — not an error toast — is the feedback; only a thrown RPC toasts
// (via `failMessage`).
async function configure(patch: Partial<KioskConfigureInput>) {
	const next: KioskConfigureInput = { display, touch, motion, performance, ...patch };
	const result = await osCommand({
		key: 'kiosk-configure',
		target: next,
		rpc: () => rpc.system.kioskConfigure(next),
		confirmOnResolve: true,
		classify: () => ({ ok: true }),
		failMessage: () => t.configureError(),
	});
	if (!result) return; // re-entry no-op or a thrown RPC (osCommand already toasted)
	if (result.error === KIOSK_UNAVAILABLE_ERROR || !result.applied) {
		unavailable = true;
		clearOperation('kiosk-configure');
		return;
	}
	unavailable = false;
	display = result.applied.display;
	touch = result.applied.touch;
	motion = result.applied.motion;
	performance = result.applied.performance;
}

// On-screen-keyboard signal routes through the keyed async-operation machine (key
// 'kiosk-osk'); `oskBusy` (derived from its `pending` phase) drives the button
// disabled state, and osCommand's own re-entry guard blocks a second signal while
// one is in flight.
async function signalOsk(visible: boolean) {
	const result = await osCommand({
		key: 'kiosk-osk',
		target: visible,
		rpc: () => rpc.system.kioskOsk({ visible }),
		confirmOnResolve: true,
		classify: () => ({ ok: true }),
		failMessage: () => t.keyboardError(),
	});
	if (!result) return; // re-entry no-op or a thrown RPC (osCommand already toasted)
	if (result.error === KIOSK_UNAVAILABLE_ERROR || !result.success) {
		unavailable = true;
		clearOperation('kiosk-osk');
		return;
	}
	unavailable = false;
}

// DC-2 state → i18n label + hint + visual tone. The single mapping that keeps
// the indicator honest: `enabled-failed` and `failed-no-display` get their own
// tone, so the UI can never paint a failed unit as "running".
const STATE_META = {
	disabled: { tone: 'neutral', spin: false },
	'enabled-stopped': { tone: 'starting', spin: true },
	'enabled-running': { tone: 'running', spin: false },
	'enabled-failed': { tone: 'failed', spin: false },
	'failed-no-display': { tone: 'warning', spin: false },
} as const satisfies Record<KioskState, { tone: string; spin: boolean }>;

const stateLabels = $derived({
	disabled: t.states.disabled(),
	'enabled-stopped': t.states.enabledStopped(),
	'enabled-running': t.states.enabledRunning(),
	'enabled-failed': t.states.enabledFailed(),
	'failed-no-display': t.states.failedNoDisplay(),
} satisfies Record<KioskState, string>);

const stateHints = $derived({
	disabled: t.stateHints.disabled(),
	'enabled-stopped': t.stateHints.enabledStopped(),
	'enabled-running': t.stateHints.enabledRunning(),
	'enabled-failed': t.stateHints.enabledFailed(),
	'failed-no-display': t.stateHints.failedNoDisplay(),
} satisfies Record<KioskState, string>);

const displayLabels = $derived({
	lcd: t.profiles.lcd(),
	eink: t.profiles.eink(),
	mono: t.profiles.mono(),
} satisfies Record<KioskDisplay, string>);

const performanceLabels = $derived({
	low: t.performanceModes.low(),
	balanced: t.performanceModes.balanced(),
	high: t.performanceModes.high(),
} satisfies Record<KioskPerformance, string>);

const meta = $derived(STATE_META[liveState]);
const dotClass = $derived(
	{
		neutral: 'bg-muted-foreground/50',
		starting: 'bg-primary motion-safe:animate-pulse',
		running: 'bg-status-success motion-safe:animate-pulse',
		failed: 'bg-destructive',
		warning: 'bg-status-warning',
	}[meta.tone],
);
const panelClass = $derived(
	{
		neutral: 'border-border bg-muted/40',
		starting: 'border-primary/30 bg-primary/5',
		running: 'border-status-success/30 bg-status-success/5',
		failed: 'border-destructive/40 bg-destructive/10',
		warning: 'border-status-warning/40 bg-status-warning/10',
	}[meta.tone],
);

const isRunning = $derived(liveState === 'enabled-running');
</script>

<AppDialog
	bind:open
	description={t.description()}
	hideFooter
	icon={Monitor}
	title={t.title()}
>
	<div class="space-y-5">
		{#if unavailable}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="kiosk-unavailable"
				role="status"
			>
				{t.unavailable()}
			</div>
		{/if}

		<!-- Live DC-2 state indicator -->
		<div
			class={cn('flex items-start gap-3 rounded-lg border px-4 py-3', panelClass)}
			data-kiosk-state={liveState}
			data-testid="kiosk-state"
			role="status"
		>
			<span class="mt-1.5 flex shrink-0 items-center">
				{#if meta.spin}
					<LoaderCircle
						class="text-primary size-4 animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>
				{:else}
					<span class={cn('size-2.5 rounded-full', dotClass)}></span>
				{/if}
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-sm font-semibold" data-testid="kiosk-state-label">
					{stateLabels[liveState]}
				</p>
				<p class="text-muted-foreground mt-0.5 text-xs">{stateHints[liveState]}</p>
			</div>
		</div>

		<!-- Enable / disable toggle (pessimistic, locks to applied) -->
		<div class="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
			<div class="min-w-0">
				<p class="text-sm font-medium">{t.enable()}</p>
				<p class="text-muted-foreground text-xs">{t.enableDesc()}</p>
			</div>
			<AsyncSwitch
				aria-label={t.enable()}
				checked={enabled}
				data-testid="kiosk-enable-switch"
				disabled={!loaded}
				onCheckedChange={handleEnableChange}
			/>
		</div>

		<!-- Display profile -->
		<div class="space-y-1.5">
			<Label class="text-muted-foreground text-xs" for="kiosk-display">{t.displayProfile()}</Label>
			<Select.Root
				disabled={!loaded}
				onValueChange={(val) => {
					if (val) void configure({ display: val as KioskDisplay });
				}}
				type="single"
				value={display}
			>
				<Select.Trigger aria-label={t.displayProfile()} class="h-10 w-full text-sm" id="kiosk-display">
					{displayLabels[display]}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#each displayOptions as option (option)}
							<Select.Item value={option}>{displayLabels[option]}</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			<p class="text-muted-foreground text-xs">{t.displayProfileDesc()}</p>
		</div>

		<!-- Touch mode -->
		<div class="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
			<div class="min-w-0">
				<p class="text-sm font-medium">{t.touch()}</p>
				<p class="text-muted-foreground text-xs">{t.touchDesc()}</p>
			</div>
			<LabeledSwitch
				checked={touch}
				disabled={!loaded}
				label={t.touch()}
				onCheckedChange={(next) => void configure({ touch: next })}
			/>
		</div>

		<!-- Reduce motion (the schema field is `motion` = animations ON; the UI
		     toggle is its inverse, so checked ⇒ motion:false). -->
		<div class="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
			<div class="min-w-0">
				<p class="text-sm font-medium">{t.motion()}</p>
				<p class="text-muted-foreground text-xs">{t.motionDesc()}</p>
			</div>
			<LabeledSwitch
				checked={!motion}
				disabled={!loaded}
				label={t.motion()}
				onCheckedChange={(next) => void configure({ motion: !next })}
			/>
		</div>

		<!-- Performance mode -->
		<div class="space-y-1.5">
			<Label class="text-muted-foreground text-xs" for="kiosk-performance">{t.performance()}</Label>
			<Select.Root
				disabled={!loaded}
				onValueChange={(val) => {
					if (val) void configure({ performance: val as KioskPerformance });
				}}
				type="single"
				value={performance}
			>
				<Select.Trigger
					aria-label={t.performance()}
					class="h-10 w-full text-sm"
					id="kiosk-performance"
				>
					{performanceLabels[performance]}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#each performanceOptions as option (option)}
							<Select.Item value={option}>{performanceLabels[option]}</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			<p class="text-muted-foreground text-xs">{t.performanceDesc()}</p>
		</div>

		<!-- On-screen keyboard. Only actionable while the kiosk is running. -->
		<div class="space-y-2">
			<div class="min-w-0">
				<p class="text-sm font-medium">{t.keyboard()}</p>
				<p class="text-muted-foreground text-xs">{t.keyboardDesc()}</p>
			</div>
			<div class="flex gap-2">
				<Button
					class="flex-1 gap-2"
					disabled={!isRunning || oskBusy}
					onclick={() => signalOsk(true)}
					variant="outline"
				>
					<Keyboard class="size-4" />
					{t.showKeyboard()}
				</Button>
				<Button
					class="flex-1 gap-2"
					disabled={!isRunning || oskBusy}
					onclick={() => signalOsk(false)}
					variant="outline"
				>
					<KeyboardOff class="size-4" />
					{t.hideKeyboard()}
				</Button>
			</div>
		</div>
	</div>
</AppDialog>
