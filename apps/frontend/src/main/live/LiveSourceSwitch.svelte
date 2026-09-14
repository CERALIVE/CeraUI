<!--
  Session targets, when reported, are authoritative: two available legs make a
  switchable pair, including one capture plus one synthetic fallback. An empty
  roster must not fall back to discovery. Without the contract, retain the legacy
  two-capture gate and identity-aware re-enumeration behavior. Discovery's virtual
  rows never become live targets. The active row remains an affirmation, not a button.
  Presentational only; onSwitch is LiveView's existing switch-input handler.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	CaptureStreamSource,
	ConfigMessage,
	DeviceKind,
	SourcesMessage,
	SessionSwitchTarget,
} from '@ceraui/rpc/schemas';
import { Cable, Check, Radio, RefreshCw, Usb, Video } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { liveSwitchRows } from '$lib/streaming/live-switch-rows';
import {
	canOfferLiveSourceSwitch,
	deriveLiveSourceState,
} from '$lib/streaming/live-source-state';

interface Props {
	switchTargets?: readonly SessionSwitchTarget[] | undefined;
	/** The unified `sources` broadcast — capture rows are filtered out of it here. */
	sources?: SourcesMessage | undefined;
	/** Active-config truth — `config.source` names the selected source id. */
	config?: ConfigMessage | undefined;
	/** Engine `active_encode` — its `active_input` is the running capture leg. */
	activeEncode?: ActiveEncode | null | undefined;
	/** Engine `active_input` — the capture source the engine is currently running. */
	activeInput?: string | undefined;
	/** The capture source with an in-flight live switch (optimistic latch). */
	switchingInput?: string | undefined;
	/** Dispatch a live input switch (LiveView's handleSwitchInput). */
	onSwitch?: (id: string) => void;
	/**
	 * LiveCockpit's active-source-lost verdict — the SAME boolean that renders the
	 * "switch to another source to keep your stream alive" alert. It opens the
	 * render gate on its own because a running id that resolves to no row is the
	 * one moment the operator most needs this card, and the capture-origin test
	 * below cannot pass in exactly that state.
	 */
	sourceLost?: boolean;
}

const {
	sources,
	config,
	activeEncode,
	activeInput,
	switchingInput,
	onSwitch,
	sourceLost = false,
	switchTargets,
}: Props = $props();

// Every capture-origin source, in broadcast order (mirrors SourceSection's filter).
const captureSources = $derived(
	(sources?.sources ?? []).filter(
		(s): s is CaptureStreamSource => s.origin === 'capture',
	),
);

const sessionTargets = $derived(switchTargets ?? activeEncode?.switch_targets);
const rosterState = $derived(sessionTargets === undefined ? 'unknown' : sessionTargets.length === 0 ? 'empty' : undefined);
const rows = $derived(sessionTargets === undefined ? captureSources : liveSwitchRows(sessionTargets, sources?.sources ?? []));

// The running source, resolved by the SAME rule that decides the lost banner —
// including the identity-aware lookup that follows a node path retired by a
// mid-stream re-enumeration onto its successor row.
const runningSource = $derived(
	deriveLiveSourceState({
		activeInput: activeEncode?.active_input ?? activeInput,
		switchTargets: sessionTargets,
		configSource: config?.source,
		sources: sources?.sources,
		isStreaming: true,
		summaryMode: false,
	}).runningSource,
);

const showCard = $derived(
	sessionTargets === undefined
		? canOfferLiveSourceSwitch(runningSource, captureSources.length, sourceLost)
		: new Set(sessionTargets.map((target) => target.input_id)).size >= 2,
);

// The row that IS the running source. `runningSource.id` (not the raw `activeInput`
// prop) is the identity-aware answer: after a mid-stream re-enumeration the engine
// still reports the node path it opened at start, and only the resolved row carries
// the id the list actually renders. `activeInput` remains the fallback for the state
// the resolver cannot answer — a running id that resolves to no row at all — where
// nothing matches anyway and every row keeps its Switch button.
const activeSourceId = $derived(sessionTargets === undefined
	? runningSource?.id ?? activeInput
	: activeEncode?.active_input ?? activeInput);

// Capture kind → coarse device family (drives icon + badge) — mirrors SourceSection.
type KindFamily = 'hdmi' | 'usb' | 'network' | 'other';
function kindFamily(kind: DeviceKind): KindFamily {
	if (kind === 'hdmi') return 'hdmi';
	if (kind === 'network') return 'network';
	if (
		kind === 'usb' ||
		kind === 'uvc_h264' ||
		kind === 'uvc_h265' ||
		kind === 'mjpeg' ||
		kind === 'camlink'
	) {
		return 'usb';
	}
	return 'other';
}
const KIND_ICON = { hdmi: Cable, usb: Usb, network: Radio, other: Video } as const;

// i18n dotted-key resolver (mirrors SourceSection) — no store dep, safe passthrough.
const t = resolveMessageKey;
// The SPECIFIC pipeline/profile label — mirrors SourceSection so the same device
// reads identically ("UVC H.264", "MJPEG", "Cam Link") whether idle or streaming,
// never the coarse "USB" collapse. `kindFamily` above still drives only the icon.
function kindLabel(kind: DeviceKind): string {
	return t(`live.inputPicker.groups.${kind}`);
}
// Hardware-encode UVC accent, mirroring SourceSection's kind badge.
function kindBadgeClass(kind: DeviceKind): string {
	return kind === 'uvc_h264' || kind === 'uvc_h265'
		? 'bg-primary/10 text-primary'
		: 'bg-muted text-muted-foreground';
}
</script>

{#if showCard}
	<Card.Root data-testid="live-source-switch">
		<Card.Content class="space-y-3 p-4 sm:p-5">
			<div class="flex items-center gap-1.5">
				<RefreshCw aria-hidden={true} class="text-primary size-4 shrink-0" />
				<span class="text-sm font-semibold">{m["live.summary.switchTitle"]()}</span>
			</div>

			<ul class="space-y-2">
				{#each rows as source (source.id)}
					{@const displayName = 'labelKey' in source && source.labelKey ? `${t(source.labelKey)} · ${source.displayName}` : source.displayName}
					{@const RowIcon = KIND_ICON[kindFamily(source.kind)]}
					{@const isActive = source.id === activeSourceId}
					<!-- A running source that VANISHED gets no lime affirmation — the lost
					     banner is up and the operator is being told to leave this row. -->
					{@const affirmActive = isActive && source.lost !== true}
					<li
						class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 {isActive
							? 'border-primary/40 bg-primary/5'
							: 'border-border'}"
						data-source-switch-row={source.id}
						data-active={isActive}
					>
						<span class="flex min-w-0 items-center gap-2.5">
							<RowIcon
								aria-hidden={true}
								class="size-4 shrink-0 {isActive ? 'text-primary' : 'text-muted-foreground'}"
							/>
							<span class="truncate text-sm font-medium" title={displayName}>{displayName}</span>
							<span
								class="{kindBadgeClass(source.kind)} shrink-0 rounded px-1.5 py-0.5 text-xs font-medium"
								data-source-kind={source.kind}
							>
								{kindLabel(source.kind)}
							</span>
						</span>

						<!-- The running row states what it IS; it offers no action, because
						     switching to the source already on air is a no-op dressed as a
						     control. Same affirmation SourceSection uses for the selected row
						     (lime Check + label), so one visual language covers both surfaces. -->
						{#if affirmActive}
							<span
								class="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold"
								data-testid={`source-selected-${source.id}`}
							>
								<Check aria-hidden={true} class="size-4" />
								{m["live.inputPicker.active"]()}
							</span>
						{:else}
							<Button
								aria-label={`${m["live.inputPicker.switch"]()} \u2013 ${displayName}`}
								data-switch-input={source.id}
								disabled={source.id === switchingInput || source.lost === true}
								onclick={() => onSwitch?.(source.id)}
								size="sm"
								variant="default"
							>
								{#if source.id === switchingInput}
									{m["live.inputPicker.switching"]()}
								{:else}
									{m["live.inputPicker.switch"]()}
								{/if}
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}

{#if rosterState && (activeEncode || activeInput)}
	<p class="text-muted-foreground text-sm" role="status" data-testid="live-switch-roster-state" data-state={rosterState}>
		{rosterState === 'unknown' ? m["live.summary.switchUnknown"]() : m["live.summary.switchEmpty"]()}
	</p>
{/if}
