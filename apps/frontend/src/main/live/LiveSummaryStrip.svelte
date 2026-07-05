<!--
  LiveSummaryStrip.svelte — the "Now streaming" summary strip (Task T12).

  A calm, presentational one-line summary of what the device is CURRENTLY doing
  while streaming, mounted FIRST inside LiveCockpit's live (non-summaryMode) branch.

  Main line:  {source} · {resolution}{fps} · {codec} · {transport} → {destination}
  Audio line: the CURRENT audio (resolved "Auto → device" or the explicit pick, or
              the "Embedded audio" copy) PLUS a calm hint pill naming the deferred
              audio-follow target when one is pending (T7). The strip shows what the
              stream is USING — never the future follow target as if it were live.

  Every field is fed from LiveView (deriveActiveSummary / resolvedAudioLabel); this
  component owns NO `$state`, NO RPC, and NO derivation of engine truth. Absent
  fields render NOTHING — never the literal string "undefined" and never a dangling
  separator. Each value sits in a `data-live-value` span for test/assistive-tech
  targeting; the container is `data-testid="live-summary-strip"`.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ArrowRightLeft, Radio } from '@lucide/svelte';

import type { ActiveSummary } from '$lib/streaming/sourceSummary';

interface Props {
	/** The active-encode summary (engine truth while streaming, else saved config). */
	summary: ActiveSummary;
	/** Human destination label (LiveView's `serverSummary`); omitted → no arrow. */
	destination?: string | undefined;
	/** The CURRENT audio label — "Auto → device" or the explicit pick; else omitted. */
	audioCurrent?: string | undefined;
	/** The deferred audio-follow target label (T7 `pending_audio_follow_asrc`). */
	audioPending?: string | undefined;
	/** Show the read-only "Embedded audio" copy instead of a device label. */
	audioEmbedded?: boolean;
}

const {
	summary,
	destination = undefined,
	audioCurrent = undefined,
	audioPending = undefined,
	audioEmbedded = false,
}: Props = $props();

// The ordered main-line segments. Each segment carries one or more atomic value
// spans; absent fields are simply omitted (no empty separator, no "undefined").
// The mode segment groups resolution + framerate WITHOUT an interior separator so
// it reads "1080p 60fps" as one token. Transport always resolves (SRTLA floor).
interface Segment {
	key: string;
	values: { key: string; text: string }[];
}
const segments = $derived.by<Segment[]>(() => {
	const segs: Segment[] = [];
	if (summary.source) {
		segs.push({ key: 'source', values: [{ key: 'source', text: summary.source }] });
	}
	const modeValues: { key: string; text: string }[] = [];
	if (summary.resolution) modeValues.push({ key: 'resolution', text: summary.resolution });
	if (typeof summary.framerate === 'number') {
		modeValues.push({ key: 'framerate', text: `${summary.framerate}fps` });
	}
	if (modeValues.length) segs.push({ key: 'mode', values: modeValues });
	if (summary.codec) segs.push({ key: 'codec', values: [{ key: 'codec', text: summary.codec }] });
	if (summary.transport) {
		segs.push({ key: 'transport', values: [{ key: 'transport', text: summary.transport }] });
	}
	return segs;
});

// The audio line renders only when there is something truthful to say: the
// embedded state, a resolved/explicit current label, or a pending-follow pill.
const hasAudioLine = $derived(audioEmbedded || Boolean(audioCurrent) || Boolean(audioPending));
</script>

<div
	class="border-primary/25 bg-primary/5 space-y-2 rounded-xl border px-4 py-3"
	data-testid="live-summary-strip"
>
	<div class="flex items-center gap-1.5">
		<span aria-hidden={true} class="bg-primary size-1.5 animate-pulse rounded-full"></span>
		<span class="text-primary text-[0.65rem] font-semibold tracking-wide uppercase">
			{$LL.live.summary.nowStreaming()}
		</span>
	</div>

	<!-- Main line: source · mode · codec · transport → destination -->
	<p class="text-foreground flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-mono text-sm">
		{#each segments as segment, i (segment.key)}
			{#if i > 0}
				<span aria-hidden={true} class="text-muted-foreground/50">&middot;</span>
			{/if}
			<span class="inline-flex items-baseline gap-x-1">
				{#each segment.values as value (value.key)}
					<span data-live-value={value.key}>{value.text}</span>
				{/each}
			</span>
		{/each}
		{#if destination}
			<span aria-hidden={true} class="text-muted-foreground">&rarr;</span>
			<span class="text-primary truncate" data-live-value="destination">{destination}</span>
		{/if}
		{#if summary.inputCodec && summary.codec}
			<span
				class="bg-primary/10 text-primary ml-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium"
				data-testid="transcode-chip"
				title={$LL.live.transcode.always()}
			>
				<ArrowRightLeft aria-hidden={true} class="size-3" />
				{$LL.live.transcode.chip({ input: summary.inputCodec, output: summary.codec })}
			</span>
		{/if}
	</p>

	<!-- Audio line: current audio + a calm pending-follow hint pill (never the -->
	<!-- future follow target rendered as if it were the live value). -->
	{#if hasAudioLine}
		<p class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
			{#if audioEmbedded}
				<span data-live-value="audio">{$LL.live.source.audioEmbedded()}</span>
			{:else if audioCurrent}
				<span class="font-mono" data-live-value="audio">{audioCurrent}</span>
			{/if}
			{#if audioPending}
				<span
					class="bg-status-info/10 text-status-info inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
					data-testid="audio-follow-pending"
				>
					<Radio aria-hidden={true} class="size-3" />
					{$LL.live.summary.audioFollows({ label: audioPending })}
				</span>
			{/if}
		</p>
	{/if}
</div>
