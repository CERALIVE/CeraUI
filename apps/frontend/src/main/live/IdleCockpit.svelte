<script lang="ts">
/**
 * IdleCockpit — the pre-stream surface (Task 11 / source-first reorder T10).
 *
 * A presentational wrapper composing the idle-mode subtrees in SOURCE-FIRST order:
 *   1. {@link SourceSection} — the unified source picker (leads the cockpit so the
 *      operator picks WHAT to stream before tuning HOW).
 *   2. {@link StreamSetupChain} — the merged "Stream setup" card (readiness rows +
 *      config-row edit affordances + the Start control at its foot). Replaces the
 *      old GoLiveCard mount (GoLiveCard stays an unmounted shim per T9).
 *   3. A collapsed "Preview" `<details>` disclosure hosting {@link PreviewCanvas}
 *      (local, off-until-toggled — never dials the engine until the operator opens
 *      it and starts the preview).
 *   4. A collapsed "Roadmap" `<details>` disclosure of calm not-yet-available pills.
 *
 * The Start control is mounted EXACTLY ONCE — inside {@link StreamSetupChain} at
 * its foot (T9). Because StreamSetupChain sits between SourceSection and the
 * disclosures, the rendered order is SourceSection → setup rows → Start → preview →
 * roadmap. IdleCockpit does NOT mount its own StreamControlButton (no double-mount).
 *
 * State ownership stays in LiveView: EVERY datum and handler here is a prop
 * threaded down from LiveView's getters/handlers. This component owns NO `$state`,
 * NO RPC, and writes NO config — it only forwards props to its children.
 */
import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	SourcesMessage,
} from '@ceraui/rpc/schemas';
import type { ResolvedAudioStatus } from '$lib/streaming/sourceSummary';

import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import SourceSection from '$lib/components/custom/SourceSection.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import { LL } from '@ceraui/i18n/svelte';
import { PictureInPicture2, Shuffle, Volume2 } from '@lucide/svelte';

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
	onOpenServer: () => void;
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
	audioStatus: ResolvedAudioStatus | undefined;
	/** Open the AudioDialog from the Source card's "Codec & delay" affordance. */
	onOpenAudioDialog: () => void;
	// `selectedPipeline` still drives the roadmap's embedded-audio pill below.
	selectedPipeline: string | undefined;
	capabilities: CapabilitiesMessage | undefined;
	activeEncode: ActiveEncode | null;
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
	activeInput,
	switchingInput,
	onSwitch,
	audioSources,
	audioSourceList,
	selectedAudioSource,
	onSelectAudioSource,
	audioStatus,
	onOpenAudioDialog,
	selectedPipeline,
	capabilities,
	activeEncode,
}: Props = $props();

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

<div class="space-y-6" data-testid="idle-cockpit">
	<!-- Source-first (T10): pick WHAT to stream before tuning HOW. -->
	<SourceSection
		{activeEncode}
		{activeInput}
		{audioSourceList}
		{audioSources}
		{audioStatus}
		{capabilities}
		{config}
		{isStreaming}
		onSelectAudioSource={onSelectAudioSource}
		{onOpenAudioDialog}
		onSwitch={onSwitch}
		{selectedAudioSource}
		{sources}
		{switchingInput}
	/>

	<!-- Stream setup: readiness rows + config edits + the Start control at its foot
	     (StreamControlButton is mounted ONCE here, never a second time — T10). -->
	<StreamSetupChain
		{config}
		{caps}
		{sources}
		{netif}
		{isConnected}
		{networkIngest}
		{pipelines}
		{configRows}
		{isStreaming}
		{optimismState}
		{destinationValidated}
		{maxBitrate}
		{onStart}
		{onStop}
		{onOpenSource}
		{onGoNetwork}
		{onOpenServer}
		{onOpenEncoder}
	/>

	<!-- Local preview — collapsed by default; PreviewCanvas stays off (no engine
	     dial) until the operator opens this disclosure and starts the preview. -->
	<details class="bg-card rounded-xl border" data-testid="preview-disclosure">
		<summary
			class="cursor-pointer list-none px-4 py-3 text-sm font-medium select-none"
		>
			{$LL.live.modes.preview()}
		</summary>
		<div class="px-4 pb-4">
			<PreviewCanvas />
		</div>
	</details>

	<!--
		Roadmap disclosure (T12) — genuine future features surfaced as calm, purely
		informational pills (NOT the disabled-with-reason warning treatment),
		collapsed by default at the very bottom of the idle cockpit. Each ComingSoon
		renders a dynamic data-debt-id into the DOM for tests; the static bindings the
		CI gate (scripts/check-tech-debt.mjs) verifies live in the literal ids in the
		comments beside each call site.
		roadmap: data-debt-id="TD-pip" data-debt-id="TD-mode-fallback"
	-->
	<details class="bg-muted/30 rounded-xl border" data-testid="live-roadmap">
		<summary
			class="text-muted-foreground cursor-pointer list-none px-4 py-3 text-sm font-medium select-none"
		>
			{$LL.live.comingSoon.roadmap()}
		</summary>
		<div class="flex flex-col gap-2.5 px-4 pb-4">
			<div class="flex items-center justify-between gap-3">
				<span class="text-muted-foreground flex items-center gap-2 text-sm">
					<PictureInPicture2 aria-hidden={true} class="size-4 shrink-0" />
					{$LL.live.comingSoon.pip()}
				</span>
				<ComingSoon debtId="TD-pip" />
			</div>
			<div class="flex items-center justify-between gap-3">
				<span class="text-muted-foreground flex items-center gap-2 text-sm">
					<Shuffle aria-hidden={true} class="size-4 shrink-0" />
					{$LL.live.comingSoon.modeFallback()}
				</span>
				<ComingSoon debtId="TD-mode-fallback" />
			</div>
			{#if audioEmbeddedComingSoon}
				<div class="flex items-center justify-between gap-3">
					<span class="text-muted-foreground flex items-center gap-2 text-sm">
						<Volume2 aria-hidden={true} class="size-4 shrink-0" />
						{$LL.live.comingSoon.embeddedAudio()}
					</span>
					<!-- CI gate static marker (component renders data-debt-id dynamically): data-debt-id="TD-embedded-audio" -->
					<ComingSoon debtId="TD-embedded-audio" label={$LL.live.comingSoon.embeddedAudio()} />
				</div>
			{/if}
		</div>
	</details>
</div>
