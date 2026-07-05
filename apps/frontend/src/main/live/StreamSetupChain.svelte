<script lang="ts">
/**
 * StreamSetupChain — the merged "Stream setup" card (Task T9).
 *
 * Replaces GoLiveCard's split of readiness-gates + config-rows with ONE card of
 * FOUR always-visible rows in signal order (Encoder → Audio → Destination →
 * Network). Each row fuses a readiness state dot with the migrated config-row
 * summary/edit affordance, so an operator reads state AND setting on one line.
 *
 * This is a PRESENTATION-ONLY remap of {@link deriveGoLiveReadiness} — the pure
 * four-gate verdict is consumed byte-unchanged and NEVER re-derived here. What
 * blocks Start is exactly what the readiness module says blocks it; the rows only
 * re-project that verdict:
 *
 *   1. Encoder     — state = the SOURCE gate (blocked wins), warn when the
 *                    encoder config row flags `pipelineNeedsReconfigure`. Summary =
 *                    encoderSummary; trailing bitrate-ceiling chip; Edit opens the
 *                    EncoderDialog.
 *   2. Audio       — ADVISORY ONLY. State is `ok`/`warn` (warn when the config row
 *                    flags the selected asrc unavailable) and NEVER `blocked`; it
 *                    contributes NOTHING to `canStart`/`blocking`/`primaryFixGate`.
 *                    Audio is deliberately not a readiness gate. Summary =
 *                    audioSummary (incl. "Auto → X"); Edit opens the AudioDialog.
 *   3. Destination — state = the DESTINATION gate. Summary = serverSummary;
 *                    trailing traffic-light chip; Edit opens the ServerDialog.
 *   4. Network     — state = the NETWORK gate. Summary = the enabled-link count
 *                    from netif; the row's action navigates to the Network view.
 *
 * The ENGINE gate is intentionally NOT a row — the CapabilityTierBanner and the
 * Start button's disabled reason own it (readiness blocking semantics unchanged).
 *
 * There is NO collapse state and NO ready bar: all four rows are ALWAYS rendered.
 *
 * As with GoLiveCard, this component owns NO RPC and writes NO config — every
 * action is a callback prop, so the sole-camera "no premature setConfig" contract
 * holds by construction: the implicit sole-camera id is folded into the Start
 * payload only, never persisted before the operator acts.
 */
import { LL } from '@ceraui/i18n/svelte';
import type {
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	SourcesMessage,
} from '@ceraui/rpc/schemas';
import { ChevronRight, Lock, Network, Pencil } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import {
	deriveGoLiveReadiness,
	type GateStatus,
	READINESS_SOURCE_REASON,
} from '$lib/streaming/go-live-readiness';
import { pipelineAvailability } from '$lib/streaming/pipelineAvailability';
import { isSectionLocked } from '$lib/streaming/streamingLockPolicy';

import StreamControlButton from './StreamControlButton.svelte';
import type { ConfigRow } from './StreamSettingsCard.svelte';

interface Props {
	// ── Readiness inputs (threaded from LiveView getters) ──────────────────────
	config: ConfigMessage | undefined;
	caps: CapabilitiesMessage | undefined;
	sources: SourcesMessage | undefined;
	netif: NetifMessage | undefined;
	isConnected: boolean;
	networkIngest: NetworkIngest | null | undefined;
	pipelines: Pipelines | undefined;
	// ── Config rows (migrated from StreamSettingsCard — same testids + locks) ───
	configRows: ConfigRow[];
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
	// ── Destination traffic-light: green when the last relay.validate passed ────
	destinationValidated?: boolean;
	// ── Bitrate-ceiling chip (opens EncoderDialog) ──────────────────────────────
	maxBitrate?: number;
	// ── Actions ─────────────────────────────────────────────────────────────────
	/** Start the stream. `overrides.source` carries the implicit sole-camera id. */
	onStart: (overrides: { source?: string }) => void;
	onStop: () => void;
	/** Source-gate fix + the sole-camera "Change" affordance. */
	onOpenSource: () => void;
	/** Network-row action — navigate to the Network destination. */
	onGoNetwork: () => void;
	/** Destination-gate fix + the traffic-light chip — open ServerDialog. */
	onOpenServer: () => void;
	/** Bitrate-ceiling chip — open EncoderDialog. */
	onOpenEncoder: () => void;
}

const {
	config,
	caps,
	sources,
	netif,
	isConnected,
	networkIngest,
	pipelines,
	configRows,
	isStreaming,
	optimismState,
	destinationValidated,
	maxBitrate,
	onStart,
	onStop,
	onOpenSource,
	onGoNetwork,
	onOpenServer,
	onOpenEncoder,
}: Props = $props();

// ── Derivations carried over VERBATIM from GoLiveCard (readiness wiring) ──────

// Sole-camera auto-select (pinned): only when config.source is unset AND there is
// EXACTLY one capture-origin source. The row never renders once config.source is
// set, and NO config is written here — the id is folded into the Start payload.
const captureSources = $derived(
	sources?.sources.filter((source) => source.origin === 'capture') ?? [],
);
const soleCamera = $derived(
	!config?.source && captureSources.length === 1 ? captureSources[0] : undefined,
);
// The id the readiness + Start use: the explicit config.source, else the implicit
// sole camera.
const effectiveSourceId = $derived(config?.source ?? soleCamera?.id);
const effectiveSourceEntry = $derived(
	effectiveSourceId
		? sources?.sources.find((source) => source.id === effectiveSourceId)
		: undefined,
);

// Gateway verdict for the effective source's pipeline — consumed by the readiness
// module (never re-derived there per the single-truth rule).
const gatewayStatus = $derived(
	pipelineAvailability(
		effectiveSourceEntry
			? pipelines?.[effectiveSourceEntry.pipelineId]
			: undefined,
		networkIngest,
	),
);

// Feed the readiness a config whose `source` reflects the implicit sole camera so
// the source gate evaluates ok BEFORE the operator presses Start — without any
// config mutation.
const readinessConfig = $derived(
	soleCamera && config ? { ...config, source: soleCamera.id } : config,
);

const readiness = $derived(
	deriveGoLiveReadiness({
		config: readinessConfig,
		caps,
		sources,
		netif,
		isConnected,
		gatewayStatus,
	}),
);

// Start gating reads the readiness verdict directly (engine gate included — it is
// owned by the Start disabled reason + CapabilityTierBanner, not a row).
const canStart = $derived(!readiness.blocking && optimismState !== 'starting');
const startDisabledReason = $derived(
	optimismState === 'starting'
		? $LL.live.starting()
		: readiness.blocking && readiness.primaryFixGate
			? resolveReason(
					readiness.gates[readiness.primaryFixGate].reasonKey ??
						READINESS_SOURCE_REASON,
				)
			: undefined,
);

function handleStartClick() {
	// The config write happens at START time (never before): fold the implicit
	// sole-camera id into the payload. When config.source is already set,
	// soleCamera is undefined so `source` is undefined and the backend keeps the
	// persisted selection.
	onStart({ source: soleCamera?.id });
}

function stateColor(state: GateStatus): string {
	if (state === 'ok') return 'var(--status-success)';
	if (state === 'warn') return 'var(--status-warning)';
	return 'var(--destructive)';
}

// i18n dot-path resolver (mirrors LiveView) — the readiness reasonKeys point at
// EXISTING leaves; resolve them without adding a switch per key.
function resolveReason(key: string): string {
	const parts = key.split('.');
	let node: unknown = $LL;
	for (const part of parts) {
		if (node && typeof node === 'object' && part in node) {
			node = (node as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof node === 'function' ? (node as () => string)() : key;
}

function formatBitrate(kbps: number | undefined): string {
	if (kbps === undefined || kbps === null) return '—';
	if (kbps >= 1000) {
		const mbps = kbps / 1000;
		const value = Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1);
		return `${value} ${$LL.units.mbps()}`;
	}
	return `${kbps} ${$LL.units.kbps()}`;
}

// ── Row projection (presentation-only remap of the readiness verdict) ─────────

// Resolve the config rows by section so each maps to its signal-order slot. The
// three come from LiveView's configRows array (same testids + edit handlers).
const encoderRow = $derived(configRows.find((row) => row.section === 'encoder'));
const audioRow = $derived(configRows.find((row) => row.section === 'audio'));
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
	if (gateState === 'blocked') return 'blocked';
	if (warn) return 'warn';
	return gateState === 'warn' ? 'warn' : 'ok';
}

const encoderState = $derived(
	rowState(readiness.gates.source.state, encoderRow?.warn),
);
// Audio is ADVISORY-ONLY: no gate, never blocked, never influences canStart.
const audioState = $derived<GateStatus>(audioRow?.warn ? 'warn' : 'ok');
const destinationState = $derived(
	rowState(readiness.gates.destination.state, serverRow?.warn),
);
const networkState = $derived(readiness.gates.network.state);

// The gate reason a row surfaces beneath its summary while not ok (audio has no
// gate, so it never shows a gate reason).
const encoderReason = $derived(
	encoderState === 'blocked' ? readiness.gates.source.reasonKey : undefined,
);
const destinationReason = $derived(
	destinationState === 'blocked'
		? readiness.gates.destination.reasonKey
		: undefined,
);
const networkReason = $derived(
	networkState !== 'ok' ? readiness.gates.network.reasonKey : undefined,
);

// Network row summary — the enabled-link count from netif (an enabled interface
// that has an IP, mirroring the network gate's own predicate).
const enabledLinkCount = $derived(
	Object.values(netif ?? {}).filter(
		(entry) => Boolean(entry?.enabled) && Boolean(entry?.ip),
	).length,
);
const networkSummary = $derived(
	enabledLinkCount > 0
		? $LL.live.setup.linksReady({ count: enabledLinkCount })
		: $LL.live.setup.noLinks(),
);
</script>

{#snippet setupRow(
	key: 'encoder' | 'audio' | 'destination',
	row: ConfigRow,
	state: GateStatus,
	reasonKey: string | undefined,
	chip: 'bitrate' | 'traffic-light' | undefined,
)}
	{@const locked = isSectionLocked(row.section, isStreaming)}
	<div
		class="flex items-center justify-between gap-4 py-2.5 first:pt-0"
		data-testid="setup-row"
		data-row={key}
		data-state={state}
		data-section={row.section}
	>
		<div class="flex min-w-0 items-start gap-3">
			<span
				class="mt-1.5 size-2 shrink-0 rounded-full"
				style="background: {stateColor(state)};"
				aria-hidden={true}
			></span>
			<row.icon
				aria-hidden={true}
				class="text-muted-foreground mt-0.5 size-4 shrink-0"
			/>
			<div class="min-w-0">
				<p class="text-sm font-medium">{row.label}</p>
				<p
					class="truncate font-mono text-sm {state === 'warn'
						? 'font-medium'
						: 'text-muted-foreground'}"
					style={state === 'warn' ? 'color: var(--status-warning);' : undefined}
				>
					{row.value}
				</p>
				{#if reasonKey}
					<p
						class="text-muted-foreground truncate text-xs"
						data-testid="setup-row-reason"
					>
						{resolveReason(reasonKey)}
					</p>
				{/if}
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			{#if chip === 'traffic-light'}
				<!-- Traffic-light: green = validated, neutral = unchecked. Never blocks
				     Start. -->
				<span
					class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
					data-testid="destination-traffic-light"
					data-validated={destinationValidated === true}
					style={destinationValidated === true
						? 'color: var(--status-success);'
						: undefined}
				>
					<span
						class="size-2 rounded-full"
						style="background: {destinationValidated === true
							? 'var(--status-success)'
							: 'var(--muted-foreground)'};"
						aria-hidden={true}
					></span>
					<span class="hidden sm:inline">
						{destinationValidated === true
							? $LL.live.goLive.validated()
							: $LL.live.goLive.notChecked()}
					</span>
				</span>
			{/if}
			{#if chip === 'bitrate' && maxBitrate}
				<!-- Bitrate-ceiling tap-to-edit chip — opens EncoderDialog. -->
				<button
					class="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex min-h-[44px] items-center rounded-md px-2 font-mono text-xs font-medium"
					data-testid="bitrate-ceiling-chip"
					onclick={onOpenEncoder}
					title={$LL.live.goLive.maxBitrate()}
					type="button"
				>
					{formatBitrate(maxBitrate)}
				</button>
			{/if}
			{#if locked}
				<span
					class="text-muted-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-xs font-medium"
					title={$LL.live.stopToChange()}
				>
					<Lock aria-hidden={true} class="h-3.5 w-3.5" />
					<span class="hidden sm:inline">{$LL.live.stopToChange()}</span>
				</span>
			{:else}
				<Button
					class="min-h-[44px] gap-1.5"
					data-testid={row.testId}
					onclick={row.onEdit}
					size="sm"
					variant="ghost"
				>
					<Pencil aria-hidden={true} class="h-3.5 w-3.5" />
					<span class="hidden sm:inline">{$LL.live.editSettings()}</span>
					<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
				</Button>
			{/if}
		</div>
	</div>
{/snippet}

<Card.Root class="overflow-hidden" data-testid="stream-setup-chain">
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-semibold">{$LL.live.setup.title()}</Card.Title>
	</Card.Header>
	<Card.Content class="space-y-4 py-0 pb-4">
		<!-- Sole-camera auto-select line — only while config.source is unset and a
		     single capture source exists. Writes NO config; Change opens the list. -->
		{#if soleCamera}
			<div
				class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
				data-testid="sole-camera-auto"
				data-source-id={soleCamera.id}
			>
				<p class="min-w-0 truncate text-sm">
					{$LL.live.goLive.autoSelected({ name: soleCamera.displayName })}
				</p>
				<Button
					class="min-h-[44px] shrink-0 gap-1.5"
					data-testid="sole-camera-change"
					onclick={onOpenSource}
					size="sm"
					variant="ghost"
				>
					{$LL.live.goLive.change()}
				</Button>
			</div>
		{/if}

		<!-- Four setup rows in signal order — always fully rendered (no collapse). -->
		<div class="divide-border divide-y">
			{#if encoderRow}
				{@render setupRow('encoder', encoderRow, encoderState, encoderReason, 'bitrate')}
			{/if}
			{#if audioRow}
				{@render setupRow('audio', audioRow, audioState, undefined, undefined)}
			{/if}
			{#if serverRow}
				{@render setupRow(
					'destination',
					serverRow,
					destinationState,
					destinationReason,
					'traffic-light',
				)}
			{/if}

			<!-- Network — synthesized (no config dialog); action navigates to Network. -->
			<div
				class="flex items-center justify-between gap-4 py-2.5 first:pt-0"
				data-testid="setup-row"
				data-row="network"
				data-state={networkState}
			>
				<div class="flex min-w-0 items-start gap-3">
					<span
						class="mt-1.5 size-2 shrink-0 rounded-full"
						style="background: {stateColor(networkState)};"
						aria-hidden={true}
					></span>
					<Network
						aria-hidden={true}
						class="text-muted-foreground mt-0.5 size-4 shrink-0"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium">{$LL.live.goLive.gate.network()}</p>
						<p class="text-muted-foreground truncate font-mono text-sm">
							{networkSummary}
						</p>
						{#if networkReason}
							<p
								class="text-muted-foreground truncate text-xs"
								data-testid="setup-row-reason"
							>
								{resolveReason(networkReason)}
							</p>
						{/if}
					</div>
				</div>
				<Button
					class="min-h-[44px] shrink-0 gap-1.5"
					data-testid="setup-row-fix"
					data-fix="goNetwork"
					onclick={onGoNetwork}
					size="sm"
					variant="ghost"
				>
					{$LL.live.goLive.fix.goNetwork()}
					<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
				</Button>
			</div>
		</div>

		<StreamControlButton
			{canStart}
			disabledReason={startDisabledReason}
			{isStreaming}
			{optimismState}
			onStart={handleStartClick}
			{onStop}
		/>
	</Card.Content>
</Card.Root>
