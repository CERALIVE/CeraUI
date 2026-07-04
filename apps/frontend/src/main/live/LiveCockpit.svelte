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
import type { LinkTelemetryMessage } from '@ceraui/rpc/schemas';

import IngestStats from '$lib/components/custom/IngestStats.svelte';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';

import BitrateAdjuster from './BitrateAdjuster.svelte';
import StreamControlButton from './StreamControlButton.svelte';
import StreamTelemetryStrip from './StreamTelemetryStrip.svelte';

interface Props {
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
	// ── StreamControlButton (Stop mode) ────────────────────────────────────────
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
	onStop: () => void;
	// ── Post-stream summary window ─────────────────────────────────────────────
	// When true the stream has stopped but LiveView is holding this cockpit mounted
	// so IngestStats can show its historical summary; collapse to summary-only.
	summaryMode?: boolean;
}

const {
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
	isStreaming,
	optimismState,
	onStop,
	summaryMode = false,
}: Props = $props();
</script>

<div class="space-y-6" data-testid="live-cockpit" data-summary-mode={summaryMode ? 'true' : 'false'}>
	{#if !summaryMode}
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

	{#if !summaryMode}
		<StreamControlButton
			canStart={false}
			{isStreaming}
			{optimismState}
			onStart={() => {}}
			{onStop}
		/>
	{/if}
</div>
