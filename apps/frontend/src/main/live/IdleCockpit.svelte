<script lang="ts">
/**
 * IdleCockpit — the pre-stream surface (Live screen contract, docs/agents/live-screen.md).
 *
 * A presentational wrapper composing the idle-mode subtrees in this order:
 *   1. {@link ProgramDesk} — the picture leads: the preview disclosure (open by
 *      default from 768 px, PreviewCanvas still off until its own toggle), then
 *      `layout-controls` while the engine advertises composition, or the
 *      stale-config notice in its place.
 *   2. {@link SourceSection} — the source tiles and, after them, the audio card.
 *   3. {@link StreamSetupChain} — the Output card (encoder + destination rows), the
 *      Connections card (network row) and the Live bar with Start.
 *   4. A collapsed "Roadmap" `<details>` disclosure of calm not-yet-available pills.
 *
 * From 1024 px the desk is the wider inline-start column and 2-4 stack in the
 * other; below that everything is one column in the order above. The Live bar is
 * fixed to the viewport bottom, so the root reserves its height at the end.
 *
 * The Start control is mounted EXACTLY ONCE — inside the Live bar of
 * {@link StreamSetupChain}. IdleCockpit does NOT mount its own StreamControlButton
 * (no double-mount).
 *
 * State ownership stays in LiveView: EVERY datum and handler here is a prop
 * threaded down from LiveView's getters/handlers. This component owns NO `$state`,
 * NO RPC, and writes NO config — it only forwards props to its children.
 */

import { m } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	RelayMessage,
	SourcesMessage,StartFailureCaptureCause 
} from '@ceraui/rpc/schemas';
import { Shuffle, TriangleAlert, Volume2 } from '@lucide/svelte';
import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import SourceSection from '$lib/components/custom/SourceSection.svelte';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import { compositionSupported } from '$lib/streaming/compositionSupport';
import type { ManagedIngestAccount } from '$lib/streaming/receiver-experience';
import type { ResolvedAudioStatus } from '$lib/streaming/sourceSummary';

import CompositionCard from './CompositionCard.svelte';
import ProgramDesk from './ProgramDesk.svelte';
import type { ConfigRow } from './StreamSettingsCard.svelte';
import StreamSetupChain from './StreamSetupChain.svelte';

interface Props {
	// ── StreamSetupChain: readiness inputs (threaded from LiveView getters) ─────
	config: ConfigMessage | undefined;
	caps: CapabilitiesMessage | undefined;
	sources: SourcesMessage | undefined;
	netif: NetifMessage | undefined;
	isConnected: boolean;
	networkIngest: NetworkIngest | null | undefined;
	pipelines: Pipelines | undefined;
	relays: RelayMessage | undefined;
	managedSlots: readonly ManagedIngestAccount[] | undefined;
	configRows: ConfigRow[];
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
	destinationValidated?: boolean;
	maxBitrate?: number;
	// ── StreamSetupChain: actions (callbacks owned by LiveView) ────────────────
	onStart: (overrides: { source?: string }) => void;
	onStop: () => void;
	/** Source-gate fix + sole-camera "Change" — LiveView scrolls/focuses the list. */
	onOpenSource: () => void;
	onGoNetwork: () => void;
	onOpenEncoder: () => void;
	// ── SourceSection: unified device-first source list + audio (Task 13) ──────
	// The live input switch (streaming-only capture-row affordance) still routes
	// through LiveView; SourceSection forwards it on its capture rows.
	activeInput: string | undefined;
	switchingInput: string | undefined;
	onSwitch: (id: string) => void;
	audioSources: string[];
	audioSourceList: AudioSource[] | undefined;
	selectedAudioSource: string | undefined;
	onSelectAudioSource: (id: string) => void;
	onAudioSelectionApplied: (asrc: string) => void;
	audioStatus: ResolvedAudioStatus | undefined;
	/** Open the AudioDialog from the Source card's "Codec & delay" affordance. */
	onOpenAudioDialog: () => void;
	// `selectedPipeline` still drives the roadmap's embedded-audio pill below.
	selectedPipeline: string | undefined;
	capabilities: CapabilitiesMessage | undefined;
	activeEncode: ActiveEncode | null;
	/** Engine capture verdict from the last start attempt, for the typed bands. */
	startFailureCaptureCause?: StartFailureCaptureCause | undefined;
}

const {
	config,
	caps,
	sources,
	netif,
	isConnected,
	networkIngest,
	pipelines,
	relays,
	managedSlots,
	configRows,
	isStreaming,
	optimismState,
	destinationValidated,
	maxBitrate,
	onStart,
	onStop,
	onOpenSource,
	onGoNetwork,
	onOpenEncoder,
	activeInput,
	switchingInput,
	onSwitch,
	audioSources,
	audioSourceList,
	selectedAudioSource,
	onSelectAudioSource,
	onAudioSelectionApplied,
	audioStatus,
	onOpenAudioDialog,
	selectedPipeline,
	capabilities,
	activeEncode,
	startFailureCaptureCause,
}: Props = $props();

const canCompose = $derived(compositionSupported(capabilities));
// A config saved while a composing engine was attached, now read by one that
// cannot. Neither silently applying it nor silently keeping it is honest, so it
// is stated here — the card itself is absent, so the notice cannot live in it.
const compositionStale = $derived(
	config?.composition !== undefined && !canCompose,
);

// Embedded network-ingest audio roadmap pill (T12, relocated from SourceSection).
// An rtmp/srt pipeline carries its audio muxed into the incoming stream; the engine
// only ROUTES it with the `network_embedded_audio` capability. Without that
// capability we surface a calm ComingSoon pill (TD-embedded-audio) in the roadmap
// disclosure — derived from the SAME inputs SourceSection reads.
const selectedPipelineAudioKind = $derived(
	selectedPipeline ? pipelines?.[selectedPipeline]?.audio_kind : undefined,
);
const audioEmbeddedComingSoon = $derived(
	selectedPipelineAudioKind === 'embedded' && capabilities?.network_embedded_audio !== true,
);
</script>

<!-- `gap-6`, not `space-y-6`: the margin utility keys on `:not(:first-child)`, so
     its rhythm is a property of DOM ORDER and loses an edge the moment a block
     becomes conditional. The measured 24px is unchanged — mechanism, not value.
     `pb-(--live-bar-height)`: the fixed Live bar publishes its own height, so the
     last block always scrolls clear of it. -->
<div
	class="flex flex-col gap-6 pb-(--live-bar-height) lg:grid lg:grid-cols-5 lg:items-start"
	data-testid="idle-cockpit"
>
	<!-- The picture leads. PreviewCanvas watches the APPLIED config.source and
	     redials on a confirmed source change. -->
	<ProgramDesk class="lg:col-span-3">
		<!-- Composition: mounted ONLY while the engine advertises the feature, so a
		     board that cannot compose renders no node at all rather than a disabled
		     card. The stale-config notice is its counterpart on the absent branch. -->
		{#if canCompose}
			<div data-testid="layout-controls">
				<CompositionCard
					captureCause={startFailureCaptureCause}
					{config}
					{isStreaming}
					{sources}
				/>
			</div>
		{:else if compositionStale}
			<div
				class="border-status-warning/50 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="composition-stale-notice"
				role="status"
			>
				<TriangleAlert aria-hidden={true} class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-status-warning text-sm font-medium">
						{m["live.composition.staleTitle"]()}
					</p>
					<p class="text-muted-foreground text-xs">{m["live.composition.staleBody"]()}</p>
				</div>
			</div>
		{/if}
	</ProgramDesk>

	<div class="flex min-w-0 flex-col gap-6 lg:col-span-2">
		<SourceSection
			{activeEncode}
			{activeInput}
			{audioSourceList}
			{audioSources}
			{audioStatus}
			{capabilities}
			{config}
			{isStreaming}
			onAudioSelectionApplied={onAudioSelectionApplied}
			onSelectAudioSource={onSelectAudioSource}
			{onOpenAudioDialog}
			onSwitch={onSwitch}
			{selectedAudioSource}
			{sources}
			{switchingInput}
		/>

		<!-- Stream setup: the Output and Connections cards + the Live bar with Start
		     (StreamControlButton is mounted ONCE here, never a second time — T10). -->
		<StreamSetupChain
			{config}
			{caps}
			{sources}
			{netif}
			{isConnected}
			{networkIngest}
			{pipelines}
			{relays}
			{managedSlots}
			{configRows}
			{isStreaming}
			{optimismState}
			{destinationValidated}
			{maxBitrate}
			{onStart}
			{onStop}
			{onOpenSource}
			{onGoNetwork}
			{onOpenEncoder}
		/>

		<!--
			Roadmap disclosure (T12) — genuine future features surfaced as calm, purely
			informational pills (NOT the disabled-with-reason warning treatment),
			collapsed by default at the very bottom of the idle cockpit. Each ComingSoon
			renders a dynamic data-debt-id into the DOM for tests; the static bindings the
			CI gate (scripts/check-tech-debt.mjs) verifies live in the literal ids in the
			comments beside each call site.
			roadmap: data-debt-id="TD-mode-fallback"
		-->
		<details class="bg-muted/30 rounded-xl border" data-testid="live-roadmap">
			<summary
				class="text-muted-foreground cursor-pointer list-none px-4 py-3 text-sm font-medium select-none"
			>
				{m["live.comingSoon.roadmap"]()}
			</summary>
			<div class="flex flex-col gap-2.5 px-4 pb-4">
				<div class="flex items-center justify-between gap-3">
					<span class="text-muted-foreground flex items-center gap-2 text-sm">
						<Shuffle aria-hidden={true} class="size-4 shrink-0" />
						{m["live.comingSoon.modeFallback"]()}
					</span>
					<ComingSoon debtId="TD-mode-fallback" />
				</div>
				{#if audioEmbeddedComingSoon}
					<div class="flex items-center justify-between gap-3">
						<span class="text-muted-foreground flex items-center gap-2 text-sm">
							<Volume2 aria-hidden={true} class="size-4 shrink-0" />
							{m["live.comingSoon.embeddedAudio"]()}
						</span>
						<!-- CI gate static marker (component renders data-debt-id dynamically): data-debt-id="TD-embedded-audio" -->
						<ComingSoon debtId="TD-embedded-audio" label={m["live.comingSoon.embeddedAudio"]()} />
					</div>
				{/if}
			</div>
		</details>
	</div>
</div>
