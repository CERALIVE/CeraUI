<script lang="ts">
/**
 * LiveCockpit — the streaming surface (Live screen contract, docs/agents/live-screen.md).
 *
 * A presentational wrapper composing the live-mode subtrees in order:
 *   1. The status banners (capture failover, lost source/signal/audio, links down).
 *   2. {@link ProgramDesk} — the preview, {@link LiveSummaryStrip}, the
 *      {@link LiveSourceSwitch} and, while the engine advertises composition,
 *      `layout-controls`.
 *   3. The audio card — {@link AudioMixer}, one strip per input — only while the
 *      engine advertises `audio_mix`.
 *   4. The telemetry card — {@link StreamTelemetryStrip} (bitrate / temp / uptime
 *      headline) and {@link IngestStats} (per-link srtla ingest telemetry + session
 *      summary).
 *   5. {@link LiveBar} — {@link BitrateAdjuster} (the ONLY field changeable
 *      mid-stream, live hot-adjust via `setBitrate`, owned by LiveView) and
 *      {@link StreamControlButton} in Stop mode; Done in the summary window.
 *
 * From 1024 px the desk is the wider inline-start column and the banners lead the
 * other column above the telemetry card; below that it is one column.
 *
 * Mounted by LiveView while `optimisticIsStreaming` is true, so the start
 * transition shows this cockpit without flicker. LiveView ALSO keeps this cockpit
 * mounted for a bounded window AFTER the stream stops (`summaryMode`) so the
 * still-mounted {@link IngestStats} can render its historical "Session ended"
 * summary before the view reverts to IdleCockpit — without that window the panel
 * would unmount the instant `isStreaming` flips false, the same tick its summary
 * would have painted. In `summaryMode` the live-only chrome (desk, telemetry
 * strip, bitrate adjuster, stop control) is hidden and ONLY the historical summary shows;
 * {@link IngestStats} is rendered UNCONDITIONALLY so its device-local session
 * rollup survives the streaming→stopped flip (its instance is never remounted).
 *
 * State ownership stays in LiveView: EVERY datum and handler here is a prop — this
 * component owns NO `$state`, NO RPC, and writes NO config.
 */
import { m } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	CapabilitiesMessage,
	ConfigMessage,
	LinkTelemetryMessage,
	SourcesMessage,
} from '@ceraui/rpc/schemas';
import { Gauge, Layers, MonitorOff, Repeat, TriangleAlert } from '@lucide/svelte';

import IngestStats from '$lib/components/custom/IngestStats.svelte';
import { Button } from '$lib/components/ui/button';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import { deriveCaptureBands, type MatchAction } from '$lib/streaming/capture-failover';
import { compositionSupported } from '$lib/streaming/compositionSupport';
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';
import { deriveLiveSourceState } from '$lib/streaming/live-source-state';
import type { ActiveSummary } from '$lib/streaming/sourceSummary';

import AudioMixer from './AudioMixer.svelte';
import BitrateAdjuster from './BitrateAdjuster.svelte';
import CompositionCard from './CompositionCard.svelte';
import LiveBar from './LiveBar.svelte';
import LiveSourceSwitch from './LiveSourceSwitch.svelte';
import LiveSummaryStrip from './LiveSummaryStrip.svelte';
import ProgramDesk from './ProgramDesk.svelte';
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
	/** Adopt the backup camera's mode as the stream settings (LiveView's apply-now save). */
	onMatchCamera?: (action: MatchAction) => void;
	// ── Layout controls (the same capabilities snapshot IdleCockpit receives) ────
	capabilities?: CapabilitiesMessage | undefined;
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
	onMatchCamera = undefined,
	capabilities = undefined,
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
const liveSource = $derived(
	deriveLiveSourceState({
		activeInput: activeEncode?.active_input,
		switchTargets: activeEncode?.switch_targets,
		captureState: activeEncode?.capture?.state,
		configSource: config?.source,
		sources: sources?.sources,
		isStreaming,
		summaryMode,
	}),
);
const activeSourceLost = $derived(liveSource.sourceLost);

// Capture failover bands, derived from the engine's own capture block. Standby
// takes precedence over the source-lost and signal-lost alerts: all three name
// the same missing picture, and only standby says what the stream is doing
// about it. The all-links-down alert stays independent — a dead bond is a
// different fact from a dead camera.
const captureBands = $derived(
	isStreaming && !summaryMode ? deriveCaptureBands(activeEncode?.capture) : [],
);
const onStandby = $derived(
	isStreaming && !summaryMode && (liveSource.standby || captureBands.some((band) => band.kind === 'standby')),
);
const showSourceLost = $derived(activeSourceLost && !onStandby);

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
	isStreaming && !summaryMode && videoSignalLost && !activeSourceLost && !onStandby,
);

const canCompose = $derived(compositionSupported(capabilities));
// The audio card exists only for an engine that mixes; without it the live
// audio line and its meter stay in LiveSummaryStrip.
const canMix = $derived(capabilities?.audio_mix !== undefined);
// Whether any banner is up: the banners lead the cards column only when they
// exist, so an alert-free stream opens no empty row above the telemetry card.
const hasBanners = $derived(
	captureBands.length > 0 || showSourceLost || showVideoSignalLost || showAudioLost || allLinksDown,
);

const BAND_CLASS =
	'border-status-warning/50 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3';
const BAND_ICON_CLASS = 'text-status-warning mt-0.5 size-4 shrink-0';
</script>

<!-- `pb-(--live-bar-height)`: the fixed Live bar publishes its own height, so the
     last block always scrolls clear of it. The two-column grid is dropped in the
     summary window, where the desk is gone and the summary stands alone; its
     flexible last row takes the desk's extra height, so the audio and telemetry
     cards sit right under the banners. -->
<div
	class="flex flex-col gap-6 pb-(--live-bar-height) {summaryMode
		? ''
		: 'lg:grid lg:grid-cols-5 lg:grid-rows-[auto_auto_1fr] lg:items-start'}"
	data-testid="live-cockpit"
	data-summary-mode={summaryMode ? 'true' : 'false'}
>
	<!-- Banners lead the cards column. -->
	{#if hasBanners}
		<div class="flex min-w-0 flex-col gap-6 lg:col-span-2 lg:col-start-4">
			{#each captureBands as band (band.kind)}
				{#if band.kind === 'standby'}
					<div class={BAND_CLASS} data-testid="capture-standby-banner" role="status">
						<MonitorOff aria-hidden={true} class={BAND_ICON_CLASS} />
						<div class="min-w-0 space-y-0.5">
							<p class="text-status-warning text-sm font-medium">{m["live.capture.standbyTitle"]()}</p>
							<p class="text-muted-foreground text-xs">{m["live.capture.standbyBody"]()}</p>
						</div>
					</div>
				{:else if band.kind === 'composition-suspended'}
					<div class={BAND_CLASS} data-testid="composition-suspended-banner" role="status">
						<Layers aria-hidden={true} class={BAND_ICON_CLASS} />
						<div class="min-w-0 space-y-0.5">
							<p class="text-status-warning text-sm font-medium">
								{m["live.capture.compositionSuspendedTitle"]()}
							</p>
							<p class="text-muted-foreground text-xs">{m["live.capture.compositionSuspendedBody"]()}</p>
						</div>
					</div>
				{:else if band.kind === 'passthrough-suspended'}
					<div class={BAND_CLASS} data-testid="passthrough-suspended-banner" role="status">
						<Repeat aria-hidden={true} class={BAND_ICON_CLASS} />
						<div class="min-w-0 space-y-0.5">
							<p class="text-status-warning text-sm font-medium">
								{m["live.capture.passthroughSuspendedTitle"]()}
							</p>
							<p class="text-muted-foreground text-xs">{m["live.capture.passthroughSuspendedBody"]()}</p>
						</div>
					</div>
				{:else if band.kind === 'rate-adapted'}
					<div class={BAND_CLASS} data-mode={band.mode} data-testid="rate-adapted-banner" role="status">
						<Gauge aria-hidden={true} class={BAND_ICON_CLASS} />
						<div class="min-w-0 space-y-0.5">
							<p class="text-status-warning text-sm font-medium">{m["live.capture.rateAdaptedTitle"]()}</p>
							<p class="text-muted-foreground text-xs">
								{band.mode === undefined
									? m["live.capture.rateAdaptedBodyUnknownMode"]()
									: m["live.capture.rateAdaptedBody"]({ mode: band.mode })}
							</p>
						</div>
					</div>
				{/if}
			{/each}

			{#if showSourceLost}
				<div
					class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3"
					data-testid="active-source-lost-banner"
					role="alert"
				>
					<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
					<div class="min-w-0 space-y-0.5">
						<p class="text-destructive text-sm font-medium">{m["live.source.lostStreamingTitle"]()}</p>
						<p class="text-muted-foreground text-xs">{m["live.source.lostStreamingBody"]()}</p>
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
							{m["live.source.signalLostStreamingTitle"]()}
						</p>
						<p class="text-muted-foreground text-xs">{m["live.source.signalLostStreamingBody"]()}</p>
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
							{m["live.source.audioLostStreamingTitle"]()}
						</p>
						<p class="text-muted-foreground text-xs">{m["live.source.audioLostStreamingBody"]()}</p>
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
							{m["live.source.linksDownStreamingTitle"]()}
						</p>
						<p class="text-muted-foreground text-xs">{m["live.source.linksDownStreamingBody"]()}</p>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if !summaryMode}
		<!-- Mid-stream preview: the engine already publishes MSE during an active
		     session (wave2 14e), so the desk's disclosure dials the same single-use-
		     token proxy and stays off until its own toggle is pressed. -->
		<ProgramDesk
			class="lg:col-span-3 lg:col-start-1 lg:row-span-3 lg:row-start-1"
			streaming={true}
		>
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
				{onMatchCamera}
				sourceLost={activeSourceLost}
			/>

			<!-- Layout: mounted ONLY while the engine advertises composition, so a board
			     that cannot compose renders no node at all. -->
			{#if canCompose}
				<div data-testid="layout-controls">
					<CompositionCard {config} {isStreaming} {sources} />
				</div>
			{/if}
		</ProgramDesk>
	{/if}

	{#if !summaryMode && canMix}
		<!-- A titled group in the cards column, like the telemetry card below it. -->
		<section
			aria-labelledby="live-audio-card-title"
			class="flex min-w-0 flex-col gap-3 lg:col-span-2 lg:col-start-4"
			data-testid="audio-card"
		>
			<h2 class="text-muted-foreground text-xs font-medium" id="live-audio-card-title">
				{m["live.audioCard.title"]()}
			</h2>
			<AudioMixer {capabilities} {config} {isStreaming} />
		</section>
	{/if}

	<!-- One titled group, not a card: the strip and the stats are surfaces already.
	     IngestStats is rendered UNCONDITIONALLY so its session rollup survives the
	     streaming→stopped flip (its instance is never remounted). -->
	<section
		aria-labelledby="live-telemetry-card-title"
		class="flex min-w-0 flex-col gap-3 lg:col-span-2 lg:col-start-4"
		data-testid="telemetry-card"
	>
		<h2 class="text-muted-foreground text-xs font-medium" id="live-telemetry-card-title">
			{m["live.telemetryCard.title"]()}
		</h2>
		{#if !summaryMode}
			<StreamTelemetryStrip
				{bitrate}
				{bitrateMeasured}
				{bitrateTarget}
				{bitrateLimit}
				{tempSensor}
				{uptimeSensor}
				{encoderLoad}
			/>
		{/if}

		<IngestStats {telemetry} {isStreaming} {bitrateKbps} />
	</section>

	<LiveBar>
		{#if summaryMode}
			<!-- Explicit close for the post-stream summary window (T13): dismisses the
			     bounded fallback timer immediately and returns the view to IdleCockpit. -->
			<Button
				type="button"
				variant="secondary"
				class="w-full sm:ms-auto sm:w-56"
				data-testid="summary-done"
				onclick={() => onCloseSummary?.()}
			>
				{m["live.ingest.done"]()}
			</Button>
		{:else}
			<div class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
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
				<div class="shrink-0 sm:min-w-56">
					<StreamControlButton
						canStart={false}
						{isStreaming}
						{optimismState}
						onStart={() => undefined}
						{onStop}
					/>
				</div>
			</div>
		{/if}
	</LiveBar>
</div>
