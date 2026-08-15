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
import { LL } from '@ceraui/i18n/i18n-svelte5';
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
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';
import { deriveLiveSourceState } from '$lib/streaming/live-source-state';
import type { ActiveSummary } from '$lib/streaming/sourceSummary';

import BitrateAdjuster from './BitrateAdjuster.svelte';
import LiveSourceSwitch from './LiveSourceSwitch.svelte';
import LiveSummaryStrip from './LiveSummaryStrip.svelte';
import PreviewDisclosure from './PreviewDisclosure.svelte';
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
	/** The headline rate (already formatted): MEASURED throughput, else the target. */
	bitrate: string;
	/** Whether `bitrate` is a real measurement rather than the engine's setpoint. */
	bitrateMeasured?: boolean;
	/** The engine's target, supplied ONLY when the measurement took the headline. */
	bitrateTarget?: string | undefined;
	/** The configured ceiling, supplied ONLY while the engine is proven to be below it. */
	bitrateLimit?: string | undefined;
	tempSensor?: string;
	uptimeSensor?: string;
	/**
	 * Per-core encoder load, derived in LiveView and passed straight through —
	 * this component reads no store, so the typed reading travels as a prop like
	 * every other datum here.
	 */
	encoderLoad?: EncoderLoadReading | undefined;
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
	/** APPLIED bitrate in kbps — folded into the session peak/avg rollup. */
	bitrateKbps?: number;
	// ── Mid-stream lifecycle banners ───────────────────────────────────────────
	// The selected audio device vanished mid-stream (LiveView derives it from the
	// available audio sources vs config.asrc). Video-source-lost and all-links-down
	// are derived inside this component from sources/activeEncode and telemetry.
	audioSourceLost?: boolean;
	// The source is still enumerated but has stopped delivering frames — an HDMI
	// cable pulled from the onboard capture node does NOT remove /dev/video0, so
	// `activeSourceLost` stays false and this is the only thing that reads it.
	// LiveView derives it from the backend health rollup (isVideoSignalLost).
	videoSignalLost?: boolean;
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
	bitrateMeasured = false,
	bitrateTarget = undefined,
	bitrateLimit = undefined,
	tempSensor,
	uptimeSensor,
	encoderLoad = undefined,
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
	videoSignalLost = false,
	isStreaming,
	optimismState,
	onStop,
	summaryMode = false,
	onCloseSummary = undefined,
}: Props = $props();

// Mid-stream active-source loss. The idle `source-lost-banner` lives in
// SourceSection, which never mounts while streaming — so an unplugged running
// source was previously silent here. The verdict is SHARED with LiveSourceSwitch
// (see live-source-state.ts) so the alert and the affordance it names agree.
const activeSourceLost = $derived(
	deriveLiveSourceState({
		activeInput: activeEncode?.active_input,
		configSource: config?.source,
		sources: sources?.sources,
		isStreaming,
		summaryMode,
	}).sourceLost,
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

// Signal loss on a source that is still THERE. Suppressed while
// `activeSourceLost` is up: that banner names the same dead picture with a more
// specific cause and a different action (reconnect / switch source), so showing
// both would stack two alerts for one outage and split the operator's attention.
const showVideoSignalLost = $derived(
	isStreaming && !summaryMode && videoSignalLost && !activeSourceLost,
);
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

	{#if showVideoSignalLost}
		<div
			class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3"
			data-testid="video-signal-lost-banner"
			role="alert"
		>
			<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
			<div class="min-w-0 space-y-0.5">
				<p class="text-destructive text-sm font-medium">
					{$LL.live.source.signalLostStreamingTitle()}
				</p>
				<p class="text-muted-foreground text-xs">{$LL.live.source.signalLostStreamingBody()}</p>
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
		     AND ≥2 capture sources exist — plus `sourceLost`, which keeps the card
		     up for exactly the alert above. The lost banner tells the operator to
		     "switch to another source to keep your stream alive", so the two MUST
		     be driven by one verdict; when they were derived independently the
		     alert outlived the affordance and instructed an impossible action. -->
		<LiveSourceSwitch
			{sources}
			{config}
			{activeEncode}
			{activeInput}
			{switchingInput}
			{onSwitch}
			sourceLost={activeSourceLost}
		/>

		<!-- Mid-stream preview: the engine already publishes MSE during an active
		     session (wave2 14e), but this disclosure only lived in IdleCockpit —
		     which unmounts on start — so that capability had no surface. Same
		     component, same single-use-token proxy dial, still off until opened. -->
		<PreviewDisclosure streaming={true} />

		<StreamTelemetryStrip
			{bitrate}
			{bitrateMeasured}
			{bitrateTarget}
			{bitrateLimit}
			{tempSensor}
			{uptimeSensor}
			{encoderLoad}
		/>

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
