<!--
  WifiModeSelector.svelte — the ONE per-adapter Station / Hotspot / Hybrid control.

  Three rules carry it, and each replaces something that used to be decided at a
  render site:

  1. NEVER HIDE, ALWAYS REASON. All three rungs are always on screen. A mode the
     radio cannot take renders `aria-disabled` with its reason as an on-screen
     `role="status"` line — never only in a `title`, because the shipped kiosk
     touchscreen cannot hover. `capability-unknown` is deliberately NOT the same
     sentence as `capability-absent`: absence of evidence is not evidence of
     absence.

  2. THE DEVICE MOVES THE CONTROL, NOT THE CLICK. `setAdapterMode` only promises
     a terminal frame follows, so the op stays `pending` after the RPC resolves
     (no `confirmOnResolve`) and the displayed mode is held on the PRIOR one,
     which the request records as it begins (`WifiModeRequest.from`). A
     failure therefore leaves the prior mode selected with the device's own typed
     reason rendered inline — `silent: true`, so it is never toast-only.

  3. A DESTRUCTIVE TRANSITION IS CONFIRMED INLINE, NOT IN A MODAL. This control
     renders inside `HotspotDialog`, which is already portalled; a modal there
     puts the consequence on a layer a touchscreen must dismiss before it can
     re-read what it is confirming. Arming the confirm dispatches nothing.

  4. THE TERMINAL FAILURE MAY BE HOSTED ELSEWHERE. `WifiSection` renders this
     control behind a "Mode" popover, which the operator can dismiss long before
     the device answers — so that surface HOSTS `WifiModeErrorBand` in its own
     card body and passes `errorPlacement="host"` to withhold the inline copy.
     Every always-visible mount keeps the default, and exactly one of the two
     ever renders the band: one fact announced twice reads as two failures.

  5. NO ACCESS POINT STARTS UNSEEN (#413). Leaving `station` for `hotspot` or
     `hybrid` opens `HotspotActivationConfirm` instead of the consequence band:
     it states the same disconnect risk AND the exact credentials the AP will
     broadcast, and dispatches only after the operator acknowledges them. "From
     station" is what the shown mode OR the radio's own row says
     (`startsApFromStation`), asked again wherever a start leaves this control:
     the rung, the inline confirm, and the automatic retry of an unanswered one.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { SetWifiAdapterModeOutput, WifiAdapterMode } from '@ceraui/rpc/schemas';
import { Ban, Loader2, RadioTower, Waypoints, Wifi } from '@lucide/svelte';
import { onDestroy, untrack } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { classifyWifiMutation } from '$lib/helpers/wifi-mode-outcome';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getLinkEpoch } from '$lib/rpc/session-epoch.svelte';
import { cn } from '$lib/utils';

import HotspotActivationConfirm from './HotspotActivationConfirm.svelte';
import WifiModeErrorBand from './WifiModeErrorBand.svelte';
import {
	actionableWifiModeConsequence,
	deriveWifiModeConsequence,
	startsApFromStation,
	type WifiAdapterModeContext,
	type WifiAdapterModeView,
	type WifiModeConfirmation,
	type WifiModeRequest,
	wifiModeConsequenceKeys,
	wifiModeDescriptionKey,
	wifiModeLabelKey,
} from './wifi-adapter-mode-view';
import { withWifiEntryRetry } from './wifi-entry-request';
import { sameWifiRadio, type WifiRadioBinding, wifiRadioChanged } from './wifi-radio-binding';
import { wifiModeOpKey } from './wifi-station-lock';

interface Props {
	view: WifiAdapterModeView;
	/** The host can see when either mode confirmation owns the consent slot. */
	confirmation?: WifiModeConfirmation;
	/** A sibling Start gate already owns the host's consent slot. */
	consentBlocked?: boolean;
	/** True if the recovered gate is about to disable the host's focused control. */
	shouldFocusRecoveredGate?: () => boolean;
	/** What the radio is doing now — decides whether a transition destroys anything. */
	context: WifiAdapterModeContext;
	/**
	 * Set when another transition already holds this adapter. Every rung goes
	 * disabled and the reason renders on screen beside them.
	 */
	lockedReason?: string;
	/** Compact rows drop the per-mode descriptions; reasons are never dropped. */
	compact?: boolean;
	/**
	 * Where the terminal failure band renders. `inline` (the default) keeps it
	 * inside this control; `host` withholds it because the mounting surface
	 * renders `WifiModeErrorBand` somewhere the operator can still see once this
	 * control has been dismissed. Never both — see rule 4 in the header.
	 */
	errorPlacement?: 'inline' | 'host';
}

let {
	view,
	confirmation = $bindable(),
	consentBlocked = false,
	shouldFocusRecoveredGate,
	context,
	lockedReason,
	compact = false,
	errorPlacement = 'inline',
}: Props = $props();

// The glyph vocabulary `WifiModeBadge` renders, carried here by the SELECTED rung
// only. On every rung it would widen the control by three glyphs, and the 375px
// row has ~50px of headroom; on the selected one it costs a single glyph and makes
// the chosen mode legible as a SHAPE rather than as "whichever pill is lime". The
// slot is shared with the rung's state marks, which outrank it: an in-flight rung
// shows its spinner and a withheld rung its `Ban`, because a rung's STATE is more
// urgent than its identity.
const GLYPH: Record<WifiAdapterMode, typeof Wifi> = {
	station: Wifi,
	hotspot: RadioTower,
	hybrid: Waypoints,
};

const armed = $derived(confirmation?.kind === 'inline' ? confirmation.mode : undefined);
const gated = $derived(confirmation?.kind === 'credentials' ? confirmation.mode : undefined);
const armedConsequence = $derived(armed === undefined ? undefined :
	actionableWifiModeConsequence(view, armed, context, consentBlocked || lockedReason !== undefined));
let modeOptions: HTMLDivElement;
let inlinePanel = $state<HTMLDivElement>();
let session = $state(0);
const radioDevice = $derived(view.device);
const radioToken = $derived(view.incarnation);
const radioReason = $derived(view.degradedReason);
let previous: WifiRadioBinding | undefined;
let admission: AbortController | undefined;
let admissionOwner: WifiRadioBinding | undefined;
let bindingUnsupported = $state(false);
let reloaded = $state(false);
let focusRecoveredGate = $state(false);

function capture(): WifiRadioBinding {
	return { device: view.device, incarnation: view.incarnation, link: getLinkEpoch(), session };
}

function current(binding: WifiRadioBinding): boolean {
	return sameWifiRadio(binding, capture());
}

$effect.pre(() => {
	const binding = { device: radioDevice, incarnation: radioToken, link: getLinkEpoch() };
	radioReason;
	const inlineActionable = armedConsequence !== undefined;
	untrack(() => {
		if (admissionOwner && (admissionOwner.device !== binding.device ||
			admissionOwner.link !== binding.link)) admission?.abort();
		const changed = previous && (previous.device !== binding.device ||
			previous.incarnation !== binding.incarnation || previous.link !== binding.link);
		if (changed) {
			bindingUnsupported = false;
			session += 1;
		}
		if (confirmation?.kind === 'inline' && (changed || !inlineActionable)) {
			if (inlinePanel?.contains(document.activeElement)) {
				const option = view.options.find((option) => option.mode === confirmation?.mode);
				const canFocusOption = option?.available && !view.pending && lockedReason === undefined &&
					(!consentBlocked || option.mode === 'station');
				const button = canFocusOption && modeOptions?.querySelector<HTMLButtonElement>(
					`button[data-mode="${option.mode}"]:not(:disabled)`,
				);
				(button || modeOptions)?.focus();
			}
			confirmation = undefined;
		}
		previous = { ...binding, session };
	});
});
onDestroy(() => { session += 1; admission?.abort(); });

const unavailable = $derived(view.options.filter((option) => !option.available));

function openRetryGate(mode: WifiAdapterMode, disposition: 'first-consent' | 'reload' | 'unsupported') {
	if (confirmation || consentBlocked) return;
	focusRecoveredGate = shouldFocusRecoveredGate?.() === true;
	if (disposition === 'unsupported') bindingUnsupported = true;
	else reloaded = disposition === 'reload';
	session += 1;
	confirmation = { kind: 'credentials', mode };
}

async function apply(mode: WifiAdapterMode, incarnation = view.incarnation, answered = false) {
	const original = capture();
	if (incarnation !== original.incarnation ||
		(mode !== 'station' && (!incarnation || view.degradedReason || consentBlocked))) return;
	confirmation = undefined;
	let replaced = false;
	let firstConsentHandoff: (() => boolean) | undefined;
	await osCommand({
		key: wifiModeOpKey(original.device, incarnation),
		classify: (result: SetWifiAdapterModeOutput) => firstConsentHandoff
			? { ok: true, clear: true }
			: classifyWifiMutation(result),
		target: { mode, from: view.displayMode } satisfies WifiModeRequest,
		rpc: async (handoff): Promise<SetWifiAdapterModeOutput> => {
			const invoke = (token?: string) => rpc.wifi.setAdapterMode({
				device: original.device, mode, ...(token !== undefined ? { incarnation: token } : {}),
			});
			if (mode === 'station') return invoke(incarnation);
			admission?.abort();
			const controller = new AbortController();
			admission = controller;
			admissionOwner = original;
			const key = wifiModeOpKey(original.device, incarnation);
			const owned = () => admission === controller && view.device === original.device &&
				getLinkEpoch() === original.link;
			const result = await withWifiEntryRetry(original, invoke, {
				signal: controller.signal,
				current: owned,
				currentToken: () => view.incarnation,
				canRetry: () => {
					// The handoff first: it alone sees that this change already settled.
					if (!current(original) || !handoff(key)) return false;
					if (answered || !startsApFromStation(view, mode)) return true;
					// Recheck ownership at settlement before releasing this attempt.
					firstConsentHandoff = () => handoff(key);
					return false;
				},
				onReplacement: () => { replaced = handoff(key); },
			});
			if (!result && !controller.signal.aborted && owned()) openRetryGate(mode, 'unsupported');
			return result ?? { success: false, error: 'binding-required' };
		},
		isCurrent: () => current(original) ? (firstConsentHandoff?.() ?? true)
			: (replaced && admissionOwner === original &&
			!admission?.signal.aborted && view.device === original.device && getLinkEpoch() === original.link),
		onResult: (result) => {
			if (mode !== 'station' && wifiRadioChanged(result)) {
				openRetryGate(mode, firstConsentHandoff ? 'first-consent' : 'reload');
			}
		},
		// The reason renders inline beneath the control; a toast would say the
		// same thing twice and then take it away.
		silent: true,
	});
}

function request(mode: WifiAdapterMode) {
	if (mode === view.displayMode || (consentBlocked && mode !== 'station')) return;
	admission?.abort();
	bindingUnsupported = false;
	reloaded = false;
	// The gate replaces the inline panel, so focus inside that panel moves to it.
	focusRecoveredGate = inlinePanel?.contains(document.activeElement) === true;
	session += 1;
	if (startsApFromStation(view, mode) || ((!view.incarnation || view.degradedReason) && mode !== 'station')) {
		confirmation = { kind: 'credentials', mode };
		return;
	}
	if (deriveWifiModeConsequence(view.displayMode, mode, context) !== undefined) {
		if (!consentBlocked) confirmation = { kind: 'inline', mode };
		return;
	}
	void apply(mode);
}
</script>

<div
	class="space-y-1.5"
	data-device={view.device}
	data-mode={view.displayMode}
	data-device-answered={view.deviceAnswered}
	data-testid="wifi-mode-selector"
>
	<div
		bind:this={modeOptions}
		aria-label={m["network.wifiMode.label"]()}
		class="flex flex-wrap gap-1.5"
		role="radiogroup"
		tabindex="-1"
	>
		{#each view.options as option (option.mode)}
			{const blocked = $derived(!option.available || view.pending || lockedReason !== undefined ||
				(consentBlocked && option.mode !== 'station'))}
			<!-- biome-ignore lint/a11y/useSemanticElements: Mode choices contain pending and unavailable glyphs with gated button activation; native radios change the content and activation model. -->
			<button
				aria-checked={option.selected}
				aria-disabled={option.available ? undefined : 'true'}
				class={cn(
					'inline-flex h-8 min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
					option.selected
						? 'border-primary bg-primary/10 text-primary'
						: 'border-border text-muted-foreground hover:bg-accent/50',
					'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
				)}
				data-available={option.available}
				data-mode={option.mode}
				data-reason={option.reason}
				data-selected={option.selected}
				data-testid="wifi-mode-option-{view.device}-{option.mode}"
				disabled={blocked}
				onclick={() => request(option.mode)}
				role="radio"
				title={option.reasonKey ? resolveMessageKey(option.reasonKey) : undefined}
				type="button"
			>
				{#if option.pending}
					<Loader2 class="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
				{:else if !option.available}
					<Ban aria-hidden="true" class="size-3 shrink-0" />
				{:else if option.selected}
					{const Glyph = $derived(GLYPH[option.mode])}
					<Glyph aria-hidden="true" class="size-3 shrink-0" />
				{/if}
				{resolveMessageKey(wifiModeLabelKey(option.mode))}
			</button>
		{/each}
	</div>

	{#if !compact}
		<p class="text-muted-foreground text-xs" data-testid="wifi-mode-hint-{view.device}">
			{resolveMessageKey(wifiModeDescriptionKey(view.displayMode))}
		</p>
	{/if}

	{#each unavailable as option (option.mode)}
		<p
			class="text-muted-foreground text-xs"
			data-mode={option.mode}
			data-reason={option.reason}
			data-testid="wifi-mode-reason-{view.device}-{option.mode}"
			role="status"
		>
			{m["network.wifiMode.unavailable"]({
				mode: resolveMessageKey(wifiModeLabelKey(option.mode)),
				reason: option.reasonKey ? resolveMessageKey(option.reasonKey) : '',
			})}
		</p>
	{/each}

	{#if lockedReason}
		<p
			class="text-status-warning text-xs"
			data-testid="wifi-mode-locked-{view.device}"
			role="status"
		>
			{lockedReason}
		</p>
	{/if}

	{#if view.pending && view.pendingTarget}
		<p
			class="text-muted-foreground text-xs"
			data-target={view.pendingTarget}
			data-testid="wifi-mode-pending-{view.device}"
			role="status"
		>
			{m["network.wifiMode.pending"]({
				mode: resolveMessageKey(wifiModeLabelKey(view.pendingTarget)),
			})}
		</p>
	{/if}

	{#if gated}
		{const gateConsequence = $derived(deriveWifiModeConsequence(view.displayMode, gated, context))}
		<HotspotActivationConfirm
			detail={gateConsequence
				? resolveMessageKey(wifiModeConsequenceKeys(gateConsequence).body)
				: undefined}
			confirmLabel={m["network.wifiMode.confirm.switchTo"]({
				mode: resolveMessageKey(wifiModeLabelKey(gated)),
			})}
			device={view.device}
			incarnation={bindingUnsupported ? undefined : view.incarnation}
			degradedReason={view.degradedReason}
			{session}
			{reloaded}
			focusOnOpen={focusRecoveredGate}
			keepsStation={gated === 'hybrid'}
			onCancel={() => { admission?.abort(); session += 1; confirmation = undefined; }}
			onConfirm={(incarnation) => gated && apply(gated, incarnation, true)}
		/>
	{/if}

	{#if armed && armedConsequence}
		{const keys = $derived(wifiModeConsequenceKeys(armedConsequence))}
		<div
			bind:this={inlinePanel}
			class="border-status-warning/30 bg-status-warning/10 space-y-2 rounded-lg border px-2.5 py-2"
			data-consequence={armedConsequence}
			data-target={armed}
			data-testid="wifi-mode-confirm-{view.device}"
			role="status"
		>
			<p class="text-status-warning text-xs font-semibold">
				{resolveMessageKey(keys.title)}
			</p>
			<p class="text-muted-foreground text-xs">{resolveMessageKey(keys.body)}</p>
			<div class="flex flex-wrap gap-2">
				<Button
					class="h-8 min-h-[var(--touch-target-min)] px-2.5"
					data-testid="wifi-mode-confirm-apply-{view.device}"
					onclick={() => armed && armedConsequence &&
						(startsApFromStation(view, armed) ? request(armed) : apply(armed))}
					size="sm"
					variant="destructive"
				>
					{resolveMessageKey(keys.confirm)}
				</Button>
				<Button
					class="h-8 min-h-[var(--touch-target-min)] px-2.5"
					data-testid="wifi-mode-confirm-cancel-{view.device}"
					onclick={() => { session += 1; confirmation = undefined; }}
					size="sm"
					variant="secondary"
				>
					{m["dialog.cancel"]()}
				</Button>
			</div>
		</div>
	{/if}

	{#if view.errorKey && errorPlacement === 'inline'}
		<WifiModeErrorBand device={view.device} error={view.error} errorKey={view.errorKey} />
	{/if}
</div>
