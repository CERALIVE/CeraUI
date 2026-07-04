<script lang="ts">
/**
 * GoLiveCard — one adaptive readiness + config + start surface (Task 10).
 *
 * Composes, in ONE card, everything an operator needs to go live:
 *   (a) Readiness rows — one per {@link deriveGoLiveReadiness} gate (source /
 *       network / destination / engine); each is a state dot + label + (when not
 *       ok) a reason and an inline fix button that opens the right surface.
 *       Disabled-with-reason is via `title`, never hidden.
 *   (b) The three compact config rows (Encoder / Audio / Server) MIGRATED from
 *       `StreamSettingsCard` — SAME testids and the SAME lock-while-streaming
 *       semantics (`isSectionLocked`), at the denser visual-eng row rhythm.
 *   (c) The server row carries a traffic-light chip (green = the last
 *       `relay.validate` passed; neutral = unvalidated). Validation NEVER blocks
 *       start — it is purely informational.
 *   (d) A bitrate-ceiling tap-to-edit chip that opens the EncoderDialog.
 *   (e) The auto-select-sole-camera behaviour, pinned EXACTLY: when exactly one
 *       capture source exists AND `config.source` is unset, the card shows an
 *       "Auto-selected: {name}" row (with a Change affordance), the source gate
 *       evaluates against that IMPLICIT source, and the Start handler folds
 *       `source: <that id>` into its payload so the config write happens at START
 *       time — NEVER before. The row disappears the moment `config.source` is set.
 *   (f) `StreamControlButton` at the foot; its disabled state + reason read from
 *       the readiness verdict (`blocking` / `primaryFixGate`).
 *   (g) When all gates are ok AND the config rows are valid (idle), the card
 *       collapses to a thin "Ready to go live" bar (re-expandable) + Start.
 *
 * The readiness verdict is derived here (the impure wiring layer) from plain data
 * props threaded from LiveView's getters; the pure rules stay in
 * `go-live-readiness.ts`. This component owns NO RPC and writes NO config — every
 * action is a callback prop (Task 11 threads the real handlers), so the
 * sole-camera "no premature setConfig" contract holds by construction.
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
import { ChevronRight, Lock, Pencil } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import {
	deriveGoLiveReadiness,
	type GateFix,
	type GateStatus,
	type GoLiveGateKey,
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
	/** Network-gate fix — navigate to the Network destination. */
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

const GATE_ORDER: readonly GoLiveGateKey[] = [
	'source',
	'network',
	'destination',
	'engine',
];

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

// Collapse-to-ready: every gate ok, no config row flagged for reconfigure, idle.
const allGatesOk = $derived(
	GATE_ORDER.every((key) => readiness.gates[key].state === 'ok'),
);
const configRowsValid = $derived(!configRows.some((row) => row.warn));
const canCollapse = $derived(allGatesOk && configRowsValid && !isStreaming);
let userExpanded = $state(false);
const collapsed = $derived(canCollapse && !userExpanded);

// Start gating reads the readiness verdict directly.
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

function runFix(fix: GateFix | undefined) {
	if (fix === 'openSource') onOpenSource();
	else if (fix === 'goNetwork') onGoNetwork();
	else if (fix === 'openServer') onOpenServer();
}

function stateColor(state: GateStatus): string {
	if (state === 'ok') return 'var(--status-success)';
	if (state === 'warn') return 'var(--status-warning)';
	return 'var(--destructive)';
}

function gateLabel(key: GoLiveGateKey): string {
	switch (key) {
		case 'source':
			return $LL.live.goLive.gate.source();
		case 'network':
			return $LL.live.goLive.gate.network();
		case 'destination':
			return $LL.live.goLive.gate.destination();
		case 'engine':
			return $LL.live.goLive.gate.engine();
	}
}

function fixLabel(fix: GateFix): string {
	switch (fix) {
		case 'openSource':
			return $LL.live.goLive.fix.openSource();
		case 'goNetwork':
			return $LL.live.goLive.fix.goNetwork();
		case 'openServer':
			return $LL.live.goLive.fix.openServer();
		case 'none':
			return '';
	}
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
</script>

<Card.Root
	class="overflow-hidden"
	data-testid="go-live-card"
	data-ready={canCollapse}
	data-collapsed={collapsed}
>
	{#if collapsed}
		<!-- All-green ready bar — thin, expandable, with Start at the foot. -->
		<Card.Content class="space-y-4 py-4">
			<div
				class="flex items-center justify-between gap-3"
				data-testid="go-live-ready-bar"
			>
				<div class="flex min-w-0 items-center gap-2.5">
					<span
						class="size-2.5 shrink-0 rounded-full"
						style="background: var(--status-success);"
						aria-hidden={true}
					></span>
					<div class="min-w-0">
						<p class="text-sm font-semibold">{$LL.live.goLive.readyTitle()}</p>
						<p class="text-muted-foreground truncate text-xs">
							{$LL.live.goLive.readyHint()}
						</p>
					</div>
				</div>
				<Button
					class="min-h-[44px] shrink-0 gap-1.5"
					data-testid="go-live-expand"
					onclick={() => (userExpanded = true)}
					size="sm"
					variant="ghost"
				>
					{$LL.live.goLive.showChecks()}
				</Button>
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
	{:else}
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-semibold">{$LL.live.streamSettings()}</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4 py-0 pb-4">
			<!-- Readiness gates — one row per gate, disabled-with-reason, never hidden. -->
			<div class="divide-border divide-y">
				{#each GATE_ORDER as key (key)}
					{@const gate = readiness.gates[key]}
					<div
						class="flex items-center justify-between gap-3 py-2.5 first:pt-0"
						data-testid="go-live-gate"
						data-gate={key}
						data-state={gate.state}
					>
						<div class="flex min-w-0 items-center gap-2.5">
							<span
								class="size-2.5 shrink-0 rounded-full"
								style="background: {stateColor(gate.state)};"
								aria-hidden={true}
							></span>
							<div class="min-w-0">
								<p class="text-sm font-medium">{gateLabel(key)}</p>
								{#if gate.state !== 'ok' && gate.reasonKey}
									<p
										class="text-muted-foreground truncate text-xs"
										data-testid="go-live-gate-reason"
									>
										{resolveReason(gate.reasonKey)}
									</p>
								{/if}
							</div>
						</div>
						{#if gate.state !== 'ok' && gate.fix && gate.fix !== 'none'}
							<Button
								class="min-h-[44px] shrink-0 gap-1.5"
								data-testid="go-live-gate-fix"
								data-fix={gate.fix}
								onclick={() => runFix(gate.fix)}
								size="sm"
								title={gate.reasonKey ? resolveReason(gate.reasonKey) : undefined}
								variant="ghost"
							>
								{fixLabel(gate.fix)}
								<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
							</Button>
						{/if}
					</div>
				{/each}
			</div>

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

			<!-- Migrated config rows — same testids + lock semantics, denser rhythm. -->
			<div class="divide-border divide-y">
				{#each configRows as row (row.label)}
					{@const locked = isSectionLocked(row.section, isStreaming)}
					<div
						class="flex items-center justify-between gap-4 py-2.5 first:pt-0"
						data-section={row.section}
					>
						<div class="flex min-w-0 items-start gap-3">
							<row.icon
								aria-hidden={true}
								class="text-muted-foreground mt-0.5 size-4 shrink-0"
							/>
							<div class="min-w-0">
								<p class="text-sm font-medium">{row.label}</p>
								<p
									class="truncate font-mono text-sm {row.warn
										? 'font-medium'
										: 'text-muted-foreground'}"
									style={row.warn ? 'color: var(--status-warning);' : undefined}
								>
									{row.value}
								</p>
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							{#if row.section === 'server'}
								<!-- Traffic-light: green = validated, neutral = unchecked. Never
								     blocks Start. -->
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
							{#if row.section === 'encoder' && maxBitrate}
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
				{/each}
			</div>

			{#if canCollapse}
				<button
					class="text-muted-foreground hover:text-foreground text-xs font-medium"
					data-testid="go-live-collapse"
					onclick={() => (userExpanded = false)}
					type="button"
				>
					{$LL.live.goLive.hideChecks()}
				</button>
			{/if}

			<StreamControlButton
				{canStart}
				disabledReason={startDisabledReason}
				{isStreaming}
				{optimismState}
				onStart={handleStartClick}
				{onStop}
			/>
		</Card.Content>
	{/if}
</Card.Root>
