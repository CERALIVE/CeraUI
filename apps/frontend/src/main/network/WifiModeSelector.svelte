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
     (no `confirmOnResolve`) and the displayed mode is held on the PRIOR one. A
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
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { WifiAdapterMode } from '@ceraui/rpc/schemas';
import { Ban, Loader2, RadioTower, Waypoints, Wifi } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import WifiModeErrorBand from './WifiModeErrorBand.svelte';
import {
	deriveWifiModeConsequence,
	type WifiAdapterModeContext,
	type WifiAdapterModeView,
	wifiModeConsequenceKeys,
	wifiModeDescriptionKey,
	wifiModeLabelKey,
} from './wifi-adapter-mode-view';
import { wifiModeOpKey } from './wifi-station-lock';

interface Props {
	view: WifiAdapterModeView;
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

const {
	view,
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

/** The mode an inline confirm is armed for. Arming dispatches nothing. */
let armed = $state<WifiAdapterMode | undefined>(undefined);

const armedConsequence = $derived(
	armed === undefined
		? undefined
		: deriveWifiModeConsequence(view.displayMode, armed, context),
);

const unavailable = $derived(view.options.filter((option) => !option.available));

async function apply(mode: WifiAdapterMode) {
	armed = undefined;
	await osCommand({
		key: wifiModeOpKey(view.device),
		target: mode,
		rpc: () => rpc.wifi.setAdapterMode({ device: view.device, mode }),
		// The reason renders inline beneath the control; a toast would say the
		// same thing twice and then take it away.
		silent: true,
	});
}

function request(mode: WifiAdapterMode) {
	if (mode === view.displayMode) return;
	if (deriveWifiModeConsequence(view.displayMode, mode, context) !== undefined) {
		armed = mode;
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
		aria-label={m["network.wifiMode.label"]()}
		class="flex flex-wrap gap-1.5"
		role="radiogroup"
	>
		{#each view.options as option (option.mode)}
			{@const blocked = !option.available || view.pending || lockedReason !== undefined}
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
					{@const Glyph = GLYPH[option.mode]}
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

	{#if armed && armedConsequence}
		{@const keys = wifiModeConsequenceKeys(armedConsequence)}
		<div
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
					onclick={() => armed && apply(armed)}
					size="sm"
					variant="destructive"
				>
					{resolveMessageKey(keys.confirm)}
				</Button>
				<Button
					class="h-8 min-h-[var(--touch-target-min)] px-2.5"
					data-testid="wifi-mode-confirm-cancel-{view.device}"
					onclick={() => (armed = undefined)}
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
