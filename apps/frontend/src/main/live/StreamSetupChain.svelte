<script lang="ts">
/**
 * StreamSetupChain — the merged "Stream setup" card (Task T9).
 *
 * Replaces GoLiveCard's split of readiness-gates + config-rows with ONE card of
 * THREE always-visible rows in signal order (Encoder → Destination → Network).
 * Each row fuses a readiness state dot with the migrated config-row summary/edit
 * affordance, so an operator reads state AND setting on one line. Audio is NOT a
 * setup-chain row (T11): the Source card is the ONE audio surface and owns the
 * "Codec & delay" affordance that opens the AudioDialog.
 *
 * This is a PRESENTATION-ONLY remap of {@link deriveGoLiveReadiness} — the pure
 * four-gate verdict is consumed byte-unchanged and NEVER re-derived here. What
 * blocks Start is exactly what the readiness module says blocks it; the rows only
 * re-project that verdict:
 *
 *   1. Encoder     — state = the SOURCE gate (blocked wins), warn when the
 *                    encoder config row flags `pipelineNeedsReconfigure`. Summary =
 *                    encoderSummary, then the bitrate ceiling, said once and itself
 *                    tappable; it and Edit open the EncoderDialog.
 *   2. Destination — state = the DESTINATION gate. Summary = serverSummary; the
 *                    check chip beside the title; Edit opens the ServerDialog.
 *   3. Network     — state = the NETWORK gate. Summary = the enabled-link count
 *                    from netif; the row's action navigates to the Network view.
 *
 * Every row is ONE pattern: a status dot, the title, one summary line, then one
 * trailing action at the same inline end. The dot is the row's tone, not its
 * gate: a destination that passes the gate but was never checked shows a hollow
 * dot, because green would claim a check that never happened.
 *
 * The ENGINE gate is intentionally NOT a row — the CapabilityTierBanner and the
 * Start button's disabled reason own it (readiness blocking semantics unchanged).
 *
 * There is NO collapse state: all three rows are ALWAYS rendered. Live screen
 * contract: Encoder + Destination form the titled Output group (`output-card`),
 * Network the Connections group (`connections-card`), and Start sits in the
 * {@link LiveBar} fixed to the viewport bottom, beside the same disabled reason
 * the button carries as its title (or the ready text when nothing blocks).
 * While blocked the bar also lists every blocked gate with a button to its
 * existing setting ("Fix these before you go live"), and a tap on the blocked
 * Start moves focus to that list instead of doing nothing.
 *
 * As with GoLiveCard, this component owns NO RPC and writes NO config — every
 * action is a callback prop, so the sole-camera "no premature setConfig" contract
 * holds by construction: the implicit sole-camera id is folded into the Start
 * payload only, never persisted before the operator acts.
 */
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { NetifMessage } from '@ceraui/rpc/schemas';
import { ChevronRight, Lock } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import type { StartAssessment } from '$lib/streaming/assess-start';
import {
	type GateStatus,
	READINESS_SOURCE_REASON,
} from '$lib/streaming/go-live-readiness';
import { isSectionLocked } from '$lib/streaming/streamingLockPolicy';

import StartPreflight from './StartPreflight.svelte';
import type { ConfigRow } from './StreamSettingsCard.svelte';

interface Props {
	assessment: StartAssessment;
	netif: NetifMessage | undefined;
	// ── Config rows (migrated from StreamSettingsCard — same testids + locks) ───
	configRows: ConfigRow[];
	isStreaming: boolean;
	// ── Destination traffic-light: green when the last relay.validate passed ────
	destinationValidated?: boolean;
	// ── Actions ─────────────────────────────────────────────────────────────────
	onStart: () => void;
	/** Source-gate fix + the sole-camera "Change" affordance. */
	onOpenSource: () => void;
	/** Network-row action — navigate to the Network destination. */
	onGoNetwork: () => void;
	onOpenAudio: () => void;
	onOpenAudioSource: () => void;
}

const {
	assessment,
	netif,
	configRows,
	isStreaming,
	destinationValidated,
	onStart,
	onOpenSource,
	onGoNetwork,
	onOpenAudio,
	onOpenAudioSource,
}: Props = $props();

const { gates, soleCamera, effectiveSourceId } = $derived(assessment);
let preflight: StartPreflight | undefined = $state();

export function focusStartOrPreflight(): boolean {
	return preflight?.focusStartOrPreflight() ?? false;
}

// The dot's tone. `unchecked` is a hollow ring, so it reads as "not known yet"
// without colour too (e-ink renders every status token in greys).
type Tone = GateStatus | 'unchecked';
const TONE_DOT: Record<Tone, string> = {
	ok: 'bg-status-success',
	warn: 'bg-status-warning',
	blocked: 'bg-destructive',
	unchecked: 'border-muted-foreground border',
	unknown: 'border-muted-foreground border',
};

// i18n dot-path resolver (mirrors LiveView) — the readiness reasonKeys point at
// EXISTING leaves; resolve them without adding a switch per key.
function resolveReason(key: string): string {
	return resolveMessageKey(key);
}

// ── Row projection (presentation-only remap of the readiness verdict) ─────────

// Resolve the config rows by section so each maps to its signal-order slot. The
// three come from LiveView's configRows array (same testids + edit handlers).
const encoderRow = $derived(configRows.find((row) => row.section === 'encoder'));
const serverRow = $derived(configRows.find((row) => row.section === 'server'));

/**
 * Fold a gate state and an advisory `warn` flag into the row's display state.
 * `blocked` always wins (it is what actually stops Start); a `warn` flag or a
 * `warn` gate is advisory. A row with no gate (audio) passes `undefined` and can
 * only ever be `ok`/`warn` — never `blocked`.
 */
function rowState(
	gateState: GateStatus | undefined,
	warn: boolean | undefined,
): GateStatus {
	if (gateState === 'blocked' || gateState === 'unknown') return gateState;
	if (warn) return 'warn';
	return gateState === 'warn' ? 'warn' : 'ok';
}

const encoderState = $derived(
	rowState(gates.source.state, encoderRow?.warn),
);
const destinationState = $derived(
	rowState(gates.destination.state, serverRow?.warn),
);
const networkState = $derived(gates.network.state);

// The gate reason a row surfaces beneath its summary while not ok (audio has no
// gate, so it never shows a gate reason).
const encoderReason = $derived(
	encoderState === 'blocked' ? gates.source.reasonKey : undefined,
);
const destinationReason = $derived(
	destinationState !== 'ok'
		? gates.destination.reasonKey
		: undefined,
);
const networkReason = $derived(
	gates.network.reasonKey,
);
const alternativeSource = $derived(gates.source.state === 'blocked' && gates.source.fix === 'chooseAnotherSource');

// Network row summary — the enabled-link count from netif (an enabled interface
// that has an IP, mirroring the network gate's own predicate).
const enabledLinkCount = $derived(
	Object.values(netif ?? {}).filter(
		(entry) => Boolean(entry?.enabled) && Boolean(entry?.ip),
	).length,
);
const networkSummary = $derived(
	networkState === 'unknown'
		? m["live.bar.checking"]()
		: enabledLinkCount > 0
		? m["live.setup.linksReady"]({ count: enabledLinkCount })
		: m["live.setup.noLinks"](),
);

interface SetupRowView {
	key: 'encoder' | 'destination' | 'network';
	label: string;
	value: string;
	state: GateStatus;
	tone: Tone;
	reasonKey: string | undefined;
	/** The migrated config row behind an editable row; the network row has none. */
	row?: ConfigRow;
}

const rows = $derived.by(() => {
	const views: SetupRowView[] = [];
	if (encoderRow) {
		views.push({
			key: 'encoder',
			label: encoderRow.label,
			value: encoderRow.value,
			state: encoderState,
			tone: encoderState,
			reasonKey: encoderReason,
			row: encoderRow,
		});
	}
	if (serverRow) {
		views.push({
			key: 'destination',
			label: serverRow.label,
			value: serverRow.value,
			state: destinationState,
			tone:
				destinationState === 'ok' && destinationValidated !== true
					? 'unchecked'
					: destinationState,
			reasonKey: destinationReason,
			row: serverRow,
		});
	}
	return views;
});
const networkView = $derived<SetupRowView>({
	key: 'network',
	label: m["live.goLive.gate.network"](),
	value: networkSummary,
	state: networkState,
	tone: networkState,
	reasonKey: networkReason,
});
</script>

{#snippet setupRow(view: SetupRowView)}
	{const row = $derived(view.row)}
	{const locked = $derived(row !== undefined && isSectionLocked(row.section, isStreaming))}
	<!-- C3: Encoder Edit is disabled-with-reason while no source resolves (encoder
	     settings key off the active source) — the Fix affordance stays the path. -->
	{const editDisabled = $derived(view.key === 'encoder' && !effectiveSourceId)}
	<div
		class="flex items-start gap-3 py-3 first:pt-0"
		data-testid="setup-row"
		data-row={view.key}
		data-state={view.state}
		data-section={row?.section}
	>
		<span
			aria-hidden={true}
			class="mt-1.5 size-2 shrink-0 rounded-full {TONE_DOT[view.tone]}"
			data-tone={view.tone}
		></span>
		<div class="min-w-0 flex-1 space-y-0.5">
			<p class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span class="text-sm font-medium">{view.label}</span>
				{#if view.key === 'destination'}
					<!-- The check's words: never blocks Start, and the dot follows it. -->
					<span
						class="rounded-full px-2 py-0.5 text-xs font-medium {destinationValidated === true
							? 'bg-status-success/10 text-status-success'
							: 'bg-muted text-muted-foreground'}"
						data-testid="destination-traffic-light"
						data-validated={destinationValidated === true}
					>
						{destinationValidated === true
							? m["live.goLive.validated"]()
							: m["live.goLive.notChecked"]()}
					</span>
				{/if}
			</p>
			<!-- The encoder's bitrate is said once, after its value, and is itself the
			     bitrate-ceiling control: it opens the Encoder dialog even while Edit
			     waits for a source, as the separate pill it replaces did. Its text box
			     is one line tall, so an ::after overlay 12 px past each edge gives it a
			     44 px target at every width without growing the line. -->
			<!-- With the bitrate, the line pads 12 px on every side and gives it back as
			     a negative margin (10 px below, keeping the column's 2 px rhythm): the
			     layout stays put while the overlay stays inside the line's own box, so
			     the line never reads as clipped. -->
			<p
				class="text-sm break-words {view.state === 'warn'
					? 'text-status-warning font-medium'
					: 'text-muted-foreground'} {row?.bitrate ? '-mx-3 -mt-3 -mb-2.5 p-3' : ''}"
			>
				{view.value}{#if row?.bitrate}{view.value ? ' \u00b7 ' : ''}<button
						class="hover:text-foreground focus-visible:ring-ring relative rounded underline underline-offset-2 outline-hidden after:absolute after:-inset-3 focus-visible:ring-2"
						data-testid="bitrate-ceiling-chip"
						data-touch-target="hit-area"
						onclick={row.onEdit}
						title={m["live.goLive.maxBitrate"]()}
						type="button">{row.bitrate}</button
					>{/if}
			</p>
			{#if view.reasonKey}
				<p class="text-muted-foreground text-xs break-words" data-testid="setup-row-reason">
					{resolveReason(view.reasonKey)}
				</p>
				{#if view.key === 'encoder' && view.state === 'blocked'}
					<!-- Source-gate fix: retargets to the source list (LiveView scrolls/
					     focuses it) — it does NOT open the encoder dialog. -->
					<button
						class="text-primary inline-flex min-h-11 items-center gap-1 text-xs font-medium hover:underline focus-visible:underline focus-visible:outline-none"
						data-testid="setup-row-fix"
						data-fix="openSource"
						onclick={onOpenSource}
						type="button"
					>
						{alternativeSource ? m["live.goLive.fix.chooseAnotherSource"]() : m["live.goLive.fix.openSource"]()}
						<ChevronRight aria-hidden={true} class="size-3.5 rtl:-scale-x-100" />
					</button>
				{/if}
			{/if}
			{#if row?.route}
				<p
					class="pt-1 text-xs {row.route.outcome === 'forceUnavailable'
						? 'text-status-warning font-medium'
						: 'text-muted-foreground'}"
					data-route={row.route.outcome}
				>
					{row.route.text}
				</p>
			{/if}
		</div>
		<!-- The ONE trailing action, at the same inline end on every row. Below
		     640 px it is the chevron alone; its words stay its accessible name. -->
		{#if row === undefined}
			<Button
				class="-my-2.5 min-h-11 min-w-11 shrink-0 gap-1"
				data-fix="goNetwork"
				data-row-action
				data-testid="setup-row-fix"
				onclick={onGoNetwork}
				size="sm"
				variant="ghost"
			>
				<span class="max-sm:sr-only">{m["live.goLive.fix.goNetwork"]()}</span>
				<ChevronRight aria-hidden={true} class="size-4 rtl:-scale-x-100" />
			</Button>
		{:else if locked}
			<span
				class="text-muted-foreground -my-2.5 inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 text-xs font-medium"
				data-row-action
				title={m["live.stopToChange"]()}
			>
				<Lock aria-hidden={true} class="size-3.5" />
				<span class="max-sm:sr-only">{m["live.stopToChange"]()}</span>
			</span>
		{:else}
			<Button
				class="-my-2.5 min-h-11 min-w-11 shrink-0 gap-1"
				data-row-action
				data-testid={row.testId}
				disabled={editDisabled}
				onclick={row.onEdit}
				size="sm"
				title={editDisabled ? resolveReason(READINESS_SOURCE_REASON) : undefined}
				variant="ghost"
			>
				<span class="max-sm:sr-only">{m["live.editSettings"]()}</span>
				<ChevronRight aria-hidden={true} class="size-4 rtl:-scale-x-100" />
			</Button>
		{/if}
	</div>
{/snippet}

<Card.Root data-testid="stream-setup-chain">
	<Card.Content class="space-y-5">
		<h2 id="live-stream-setup-title" tabindex="-1" class="text-base font-semibold">{m["live.setup.title"]()}</h2>

		<!-- Sole-camera auto-select line — only while config.source is unset and a
		     single capture source exists. Writes NO config; Change opens the list. -->
		{#if soleCamera}
			<div
				class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
				data-testid="sole-camera-auto"
				data-source-id={soleCamera.id}
			>
				<p class="min-w-0 text-sm [overflow-wrap:anywhere]">
					{m["live.goLive.autoSelected"]({ name: soleCamera.displayName })}
				</p>
				<Button
					class="min-h-11 shrink-0 gap-1.5"
					data-testid="sole-camera-change"
					onclick={onOpenSource}
					size="sm"
					variant="ghost"
				>
					{m["live.goLive.change"]()}
				</Button>
			</div>
		{/if}

		<!-- Setup rows in signal order — always fully rendered (no collapse). Titled
		     groups inside this card, split by a hairline, never cards in a card. -->
		{#if rows.length > 0}
			<section aria-labelledby="live-output-card-title" data-testid="output-card">
				<h3 class="pb-3 text-sm font-semibold" id="live-output-card-title">
					{m["live.outputCard.title"]()}
				</h3>
				<div class="divide-border divide-y">
					{#each rows as view (view.key)}
						{@render setupRow(view)}
					{/each}
				</div>
			</section>
		{/if}

		<section
			aria-labelledby="live-connections-card-title"
			class="border-t pt-5"
			data-testid="connections-card"
		>
			<h3 class="pb-3 text-sm font-semibold" id="live-connections-card-title">
				{m["live.connectionsCard.title"]()}
			</h3>
			{@render setupRow(networkView)}
		</section>

		<StartPreflight
			bind:this={preflight}
			decision={assessment.decision}
			{onStart}
			{onOpenSource}
			{onGoNetwork}
			{onOpenAudio}
			{onOpenAudioSource}
			onOpenServer={serverRow?.onEdit}
		/>
	</Card.Content>
</Card.Root>
