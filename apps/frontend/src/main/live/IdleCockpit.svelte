<script lang="ts">
/**
 * IdleCockpit — the pre-stream surface (Task 11).
 *
 * A presentational wrapper composing the three idle-mode subtrees in order:
 *   1. {@link GoLiveCard} — the one adaptive readiness + config + start surface
 *      (absorbs the old OnboardingChecklist, no-server empty-state, ServerReadiness
 *      and StreamSettingsCard mounts).
 *   2. A collapsed "Preview" `<details>` disclosure hosting {@link PreviewCanvas}
 *      (local, off-until-toggled — never dials the engine until the operator opens
 *      it and starts the preview).
 *   3. {@link SourceSection} — the unified source picker.
 *
 * State ownership stays in LiveView: EVERY datum and handler here is a prop
 * threaded down from LiveView's getters/handlers. This component owns NO `$state`,
 * NO RPC, and writes NO config — it only forwards props to its children.
 */
import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	CaptureDevice,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	SourcesMessage,
} from '@ceraui/rpc/schemas';

import SourceSection from '$lib/components/custom/SourceSection.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import type { StreamingOptimismState } from '$lib/rpc/streaming-optimism.svelte';
import type { FailoverEvent } from '$lib/streaming/source-preference';
import { LL } from '@ceraui/i18n/svelte';

import GoLiveCard from './GoLiveCard.svelte';
import type { ConfigRow } from './StreamSettingsCard.svelte';

interface Props {
	// ── GoLiveCard: readiness inputs (threaded from LiveView getters) ──────────
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
	// ── GoLiveCard: actions (callbacks owned by LiveView) ──────────────────────
	onStart: (overrides: { source?: string }) => void;
	onStop: () => void;
	onOpenSource: () => void;
	onGoNetwork: () => void;
	onOpenServer: () => void;
	onOpenEncoder: () => void;
	// ── SourceSection: video ───────────────────────────────────────────────────
	devices: CaptureDevice[];
	activeInput: string | undefined;
	selectedInput: string | undefined;
	switchingInput: string | undefined;
	audioLiveSwitchEnabled: boolean;
	audioLiveSwitchField: string;
	onSelect: (id: string) => void;
	onSwitch: (id: string) => void;
	// ── SourceSection: audio ───────────────────────────────────────────────────
	audioSources: string[];
	audioSourceList: AudioSource[] | undefined;
	selectedAudioSource: string | undefined;
	onSelectAudioSource: (id: string) => void;
	// ── SourceSection: network-ingest + capability + active-config ─────────────
	selectedPipeline: string | undefined;
	onSelectNetworkIngest: (pipelineId: string) => void;
	capabilities: CapabilitiesMessage | undefined;
	activeEncode: ActiveEncode | null;
	// ── SourceSection: source preference + fallback ────────────────────────────
	sourceOrder: string[];
	sourceFailover: FailoverEvent | null;
	sourcePreferenceField: string;
	onReorderSource: (id: string, direction: 'up' | 'down') => void;
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
	devices,
	activeInput,
	selectedInput,
	switchingInput,
	audioLiveSwitchEnabled,
	audioLiveSwitchField,
	onSelect,
	onSwitch,
	audioSources,
	audioSourceList,
	selectedAudioSource,
	onSelectAudioSource,
	selectedPipeline,
	onSelectNetworkIngest,
	capabilities,
	activeEncode,
	sourceOrder,
	sourceFailover,
	sourcePreferenceField,
	onReorderSource,
}: Props = $props();
</script>

<div class="space-y-6" data-testid="idle-cockpit">
	<GoLiveCard
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
			class="cursor-pointer list-none px-5 py-3 text-sm font-medium select-none"
		>
			{$LL.live.modes.preview()}
		</summary>
		<div class="px-5 pb-5">
			<PreviewCanvas />
		</div>
	</details>

	<SourceSection
		{activeInput}
		{activeEncode}
		{audioLiveSwitchField}
		{audioLiveSwitchEnabled}
		{audioSourceList}
		{audioSources}
		{capabilities}
		{config}
		{devices}
		{isStreaming}
		{networkIngest}
		onReorderSource={onReorderSource}
		onSelect={onSelect}
		onSelectAudioSource={onSelectAudioSource}
		onSelectNetworkIngest={onSelectNetworkIngest}
		onSwitch={onSwitch}
		{pipelines}
		{selectedAudioSource}
		{selectedPipeline}
		{selectedInput}
		{sourceFailover}
		{sourceOrder}
		{sourcePreferenceField}
		{switchingInput}
	/>
</div>
