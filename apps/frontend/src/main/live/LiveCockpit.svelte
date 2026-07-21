<script lang="ts">
/**
 * LiveCockpit — the streaming surface (Task 11).
 *
 * A presentational wrapper composing the four live-mode subtrees in order:
 *   1. {@link StreamTelemetryStrip} — bitrate / temp / uptime headline.
 *   2. {@link BitrateAdjuster} — the ONLY field changeable mid-stream (live
 *      hot-adjust via `setBitrate`, owned by LiveView).
 *   3. {@link IngestStats} — per-link srtla ingest telemetry + session summary.
 *   4. {@link StreamControlButton} — in Stop mode.
 *
 * Mounted by LiveView while `optimisticIsStreaming` is true, so the start
 * transition shows this cockpit without flicker. LiveView ALSO keeps this cockpit
 * mounted for a bounded window AFTER the stream stops (`summaryMode`) so the
 * still-mounted {@link IngestStats} can render its historical "Session ended"
 * summary before the view reverts to IdleCockpit — without that window the panel
 * would unmount the instant `isStreaming` flips false, the same tick its summary
 * would have painted. In `summaryMode` the live-only chrome (telemetry strip,
 * bitrate adjuster, stop control) is hidden and ONLY the historical summary shows;
 * {@link IngestStats} is rendered UNCONDITIONALLY so its device-local session
 * rollup survives the streaming→stopped flip (its instance is never remounted).
 *
 * State ownership stays in LiveView: EVERY datum and handler here is a prop — this
 * component owns NO `$state`, NO RPC, and writes NO config.
 */
import { LL } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	ConfigMessage,
	LinkTelemetryMessage,
	SourcesMessage,
} from '@ceraui/rpc/schemas';
import { TriangleAlert } from '@lucide/svelte';

import IngestStats from '$lib/components/custom/IngestStats.svelte';
import { Button } from '$lib/components/ui/button';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import type { ActiveSummary } from '$lib/streaming/sourceSummary';

import BitrateAdjuster from './BitrateAdjuster.svelte';
import LiveSourceSwitch from './LiveSourceSwitch.svelte';
import LiveSummaryStrip from './LiveSummaryStrip.svelte';
import StreamControlButton from './StreamControlButton.svelte';
import StreamTelemetryStrip from './StreamTelemetryStrip.svelte';

interface Props {
	// ── LiveSummaryStrip ("Now streaming" summary) ─────────────────────────────
	liveSummary: ActiveSummary;
	destination?: string | undefined;
	audioCurrent?: string | undefined;
	audioPending?: string | undefined;
	audioEmbedded?: boolean;
	// ── LiveSourceSwitch (live capture-source switch card) ─────────────────────
	sources?: SourcesMessage | undefined;
	config?: ConfigMessage | undefined;
	activeEncode?: ActiveEncode | null | undefined;
	activeInput?: string | undefined;
	switchingInput?: string | undefined;
	onSwitch?: (id: string) => void;
	// ── StreamTelemetryStrip ────────────────────────────────────────────────────
	bitrate: string;
	tempSensor?: string;
	uptimeSensor?: string;
	// ── BitrateAdjuster (live hot-adjust) ──────────────────────────────────────
	bitrateDraft: number;
	bitrateLabel: string;
	bitrateMin: number;
	bitrateMax: number;
	sliderMin: number;
	sliderMax: number;
	step: number;
	onStep: (delta: number) => void;
	onSliderChange: (value: number) => void;
	onSliderCommit: (value: number) => void;
	// ── IngestStats ─────────────────────────────────────────────────────────────
	telemetry: LinkTelemetryMessage | null | undefined;
	bitrateKbps?: number;
	// ── Mid-stream lifecycle banners ───────────────────────────────────────────
	// The selected audio device vanished mid-stream (LiveView derives it from the
	// available audio sources vs config.asrc). Video-source-lost and all-links-down
	// are derived inside this component from sources/activeEncode and telemetry.
	audioSourceLost?: boolean;
	// ── StreamControlButton (Stop mode) ────────────────────────────────────────
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
	onStop: () => void;
	// ── Post-stream summary window ─────────────────────────────────────────────
	// When true the stream has stopped but LiveView is holding this cockpit mounted
	// so IngestStats can show its historical summary; collapse to summary-only.
	summaryMode?: boolean;
	// Explicit "Done" escape from the post-stream summary window (T13): renders a
	// footer button ONLY in summaryMode; clicking it closes the window immediately
	// (LiveView clears the flag AND the fallback timer). Idempotent at the source.
	onCloseSummary?: () => void;
}

const {
	liveSummary,
	destination = undefined,
	audioCurrent = undefined,
	audioPending = undefined,
	audioEmbedded = false,
	sources = undefined,
	config = undefined,
	activeEncode = undefined,
	activeInput = undefined,
	switchingInput = undefined,
	onSwitch = undefined,
	bitrate,
	tempSensor,
	uptimeSensor,
	bitrateDraft,
	bitrateLabel,
	bitrateMin,
	bitrateMax,
	sliderMin,
	sliderMax,
	step,
	onStep,
	onSliderChange,
	onSliderCommit,
	telemetry,
	bitrateKbps,
	audioSourceLost = false,
	isStreaming,
	optimismState,
	onStop,
	summaryMode = false,
	onCloseSummary = undefined,
}: Props = $props();

// Mid-stream active-source loss. The idle `source-lost-banner` lives in
// SourceSection, which never mounts while streaming — so an unplugged running
// source was previously silent here. Fire ONLY once the `sources` snapshot has
// arrived (an empty list is the pre-first-broadcast state, not a loss) and only
// while actually live: either the running id is gone from the list, or it is
// present but flagged `lost`.
const runningId = $derived(activeEncode?.active_input ?? config?.source);
const runningSource = $derived(
	runningId ? sources?.sources.find((s) => s.id === runningId) : undefined,
);
const activeSourceLost = $derived(
	isStreaming &&
		!summaryMode &&
		runningId !== undefined &&
		(sources?.sources.length ?? 0) > 0 &&
		(runningSource === undefined || runningSource.lost === true),
);

// All bonded links down mid-stream: every reported link is stale while ≥1 link
// exists. Distinct from a partial drop (some links still active).
const allLinksDown = $derived(
	isStreaming &&
		!summaryMode &&
		(telemetry?.links.length ?? 0) > 0 &&
		(telemetry?.links.every((link) => link.stale) ?? false),
);

const showAudioLost = $derived(isStreaming && !summaryMode && audioSourceLost);
</script>

<div class="space-y-6" data-testid="live-cockpit" data-summary-mode={summaryMode ? 'true' : 'false'}>
	{#if activeSourceLost}
		<div
			class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3"
			data-testid="active-source-lost-banner"
			role="alert"
		>
			<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
			<div class="min-w-0 space-y-0.5">
				<p class="text-destructive text-sm font-medium">{$LL.live.source.lostStreamingTitle()}</p>
				<p class="text-muted-foreground text-xs">{$LL.live.source.lostStreamingBody()}</p>
			</div>
		</div>
	{/if}

	{#if showAudioLost}
		<div
			class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3"
			data-testid="active-audio-lost-banner"
			role="alert"
		>
			<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
			<div class="min-w-0 space-y-0.5">
				<p class="text-destructive text-sm font-medium">
					{$LL.live.source.audioLostStreamingTitle()}
				</p>
				<p class="text-muted-foreground text-xs">{$LL.live.source.audioLostStreamingBody()}</p>
			</div>
		</div>
	{/if}

	{#if allLinksDown}
		<div
			class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3"
			data-testid="all-links-down-banner"
			role="alert"
		>
			<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
			<div class="min-w-0 space-y-0.5">
				<p class="text-destructive text-sm font-medium">
					{$LL.live.source.linksDownStreamingTitle()}
				</p>
				<p class="text-muted-foreground text-xs">{$LL.live.source.linksDownStreamingBody()}</p>
			</div>
		</div>
	{/if}

	{#if !summaryMode}
		<!-- "Now streaming" summary strip: what the device is CURRENTLY streaming
		     (source · mode · codec · transport → destination + audio line). -->
		<LiveSummaryStrip
			summary={liveSummary}
			{destination}
			{audioCurrent}
			{audioPending}
			{audioEmbedded}
		/>

		<!-- Live capture-source switch: the ONLY reachable surface for a live input
		     switch while streaming (SourceSection's streaming branch never mounts
		     here). Self-gates: renders nothing unless the running source is capture
		     AND ≥2 capture sources exist. -->
		<LiveSourceSwitch
			{sources}
			{config}
			{activeEncode}
			{activeInput}
			{switchingInput}
			{onSwitch}
		/>

		<StreamTelemetryStrip {bitrate} {tempSensor} {uptimeSensor} />

		<!-- Bitrate hot-adjust — the only field changeable mid-stream (setBitrate). -->
		<BitrateAdjuster
			{bitrateDraft}
			{bitrateLabel}
			{bitrateMax}
			{bitrateMin}
			onSliderChange={onSliderChange}
			onSliderCommit={onSliderCommit}
			onStep={onStep}
			{sliderMax}
			{sliderMin}
			{step}
		/>
	{/if}

	<IngestStats {telemetry} {isStreaming} {bitrateKbps} />

	{#if summaryMode}
		<!-- Explicit close for the post-stream summary window (T13): dismisses the
		     bounded fallback timer immediately and returns the view to IdleCockpit. -->
		<Button
			type="button"
			variant="secondary"
			class="w-full"
			data-testid="summary-done"
			onclick={() => onCloseSummary?.()}
		>
			{$LL.live.ingest.done()}
		</Button>
	{:else}
		<StreamControlButton
			canStart={false}
			{isStreaming}
			{optimismState}
			onStart={() => {}}
			{onStop}
		/>
	{/if}
</div>
