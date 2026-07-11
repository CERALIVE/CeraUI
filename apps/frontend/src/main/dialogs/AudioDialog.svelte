<!--
  AudioDialog.svelte — focused audio-configuration dialog for the Live destination.

  Scoped to ENCODING knobs only (Task 15): the audio-source SELECTION now lives
  exclusively in the unified Source section (`SourceSection.svelte`, the sole
  `asrc` writer). This dialog is a read-only CONSUMER of the active audio source
  and owns just two controls:
    • Audio codec  — Select (aac / opus) over the device-supported codecs.
    • Audio delay  — center-zero slider, bounds driven by
                     `streamingConstraints.audioDelay.{min,max}` (no literals).

  Above them a READ-ONLY line surfaces the active audio source (device label or
  the embedded-stream state) with a "change it in the Source section" hint — the
  operator changes the source there, not here. The `hasAudioSupport` gate (from
  `resolveAudioGateState`) is preserved verbatim.

  Persistence: Save persists the audio fields via `rpc.streaming.setConfig`
  (no stream restart) and also commits them optimistically to the caller via
  `onSave` so the Live summary updates immediately. `handleSave` writes ONLY
  `acodec`/`delay` — `asrc` is never in its payload. Audio is locked while
  streaming (the Live row's lock policy hides the Edit trigger mid-stream, so
  Save only runs while idle). Federation tolerance: the dialog mounts and saves
  with `asrc` absent from config.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AUDIO_SOURCE_AUTO, audioCodecSchema, type AudioCodec } from '@ceraui/rpc/schemas';
import { Volume2 } from '@lucide/svelte';
import { toast } from 'svelte-sonner';
import type { FederationHostAdapter } from '$lib/federation/host-contract';

import { AppDialog } from '$lib/components/dialogs';
import {
	audioCodecAllowedForTransport,
	streamingConstraints,
} from '$lib/components/streaming/ValidationAdapter';
import {
	resolveAudioGateState,
	resolveAudioPipelineKey,
} from '$lib/streaming/audioGate';
import {
	audioSourceLabel,
	resolveAudioSourceList,
	resolvedAudioLabel,
} from '$lib/streaming/sourceSummary';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import AudioDialogContent from './audio/AudioDialogContent.svelte';
import {
	getAudioCodecs,
	getCapabilities,
	getConfig,
	getIsStreaming,
	getPipelines,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';

export interface AudioConfigValues {
	/**
	 * Optional (Task 15): this dialog NEVER writes `asrc` — the Source section is
	 * the sole `asrc` writer. Kept optional so the shared override type used by
	 * LiveView's inline source-pick still carries it.
	 */
	asrc?: string;
	acodec: AudioCodec;
	delay: number;
}

interface Props {
	open?: boolean;
	/** Effective current values (override-or-config) seeded into the draft on open. */
	audioSource?: string;
	audioCodec?: AudioCodec;
	audioDelay?: number;
	/**
	 * Effective encoder pipeline driving the audio gate: the DRAFTED encoder
	 * source first, the saved config pipeline as fallback. When omitted the gate
	 * falls back to the saved device config alone.
	 */
	effectivePipeline?: string;
	/** Commit handler — receives the validated draft when Save is pressed. */
	onSave?: (values: AudioConfigValues) => void;
	/**
	 * Opens the Encoder dialog from the no-video-source gate (Todo 26): audio can
	 * only be configured once the encoder has a video source, so the gate offers a
	 * direct jump instead of leaving the operator to hunt for it.
	 */
	onOpenEncoder?: () => void;
	hostAdapter?: FederationHostAdapter;
}

let {
	open = $bindable(false),
	audioSource,
	audioCodec,
	audioDelay,
	effectivePipeline,
	onSave,
	onOpenEncoder,
	hostAdapter,
}: Props = $props();

// Schema-driven slider bounds — single source of truth, zero literals.
const DELAY_MIN = streamingConstraints.audioDelay.min;
const DELAY_MAX = streamingConstraints.audioDelay.max;
const DELAY_STEP = 5;

// Live device state (non-deprecated subscriptions getters).
const config = $derived(getConfig());
const pipelines = $derived(getPipelines()?.pipelines);
const audioCodecs = $derived(getAudioCodecs());
const audioSources = $derived(getStatus()?.asrcs ?? []);
const audioSourceList = $derived(getStatus()?.audio_sources);
const capabilities = $derived(getCapabilities());
const isStreaming = $derived(getIsStreaming());

// Gate follows the DRAFTED encoder pipeline first, the saved config second —
// so picking an audio-capable pipeline in the Encoder dialog clears the gate
// immediately, without waiting for a stream (re)start to persist it.
const pipelineKey = $derived(
	resolveAudioPipelineKey(effectivePipeline, config?.pipeline),
);
const gateState = $derived(resolveAudioGateState(pipelineKey, pipelines));
const hasAudioSupport = $derived(hostAdapter !== undefined || gateState === 'enabled');

// Typed audio-source model (Task 13): pseudo-sources translated + grouped last,
// device entries keep their hardware name + backend order. Used ONLY to resolve
// the READ-ONLY active-source label — the selection itself lives in SourceSection.
const audioSourceEntries = $derived(resolveAudioSourceList(audioSourceList, audioSources));

// Embedded network-ingest audio (Task 13): with the `network_embedded_audio`
// capability, an rtmp/srt pipeline routes its muxed audio and the source is
// read-only; without it the ALSA picker stays and we show a ComingSoon pill.
const selectedPipelineAudioKind = $derived(
	pipelineKey ? pipelines?.[pipelineKey]?.audio_kind : undefined,
);
const audioEmbeddedActive = $derived(
	selectedPipelineAudioKind === 'embedded' && capabilities?.network_embedded_audio === true,
);
const audioEmbeddedComingSoon = $derived(
	selectedPipelineAudioKind === 'embedded' && capabilities?.network_embedded_audio !== true,
);

// ---- Draft state (seeded from props each time the dialog opens) ----
// `asrc` is NO LONGER drafted here — the Source section owns it.
let draftCodec = $state<AudioCodec | undefined>(undefined);
let draftDelay = $state(0);
let wasOpen = $state(false);

// Federation prop-boundary coercion (C5): an OLD platform mounting the NEW
// federation `audio.js` may still hand us the retired `pcm` codec (removed from
// the enum). Map it to `aac` at the boundary so the draft never seeds a value
// outside the current enum and Save never emits `pcm`.
function coerceIncomingCodec(codec: AudioCodec | undefined): AudioCodec {
	return codec === undefined || String(codec) === 'pcm' ? 'aac' : codec;
}

$effect(() => {
	if (open && !wasOpen) {
		// Opening: seed the draft from the effective current values.
		draftCodec = coerceIncomingCodec(audioCodec);
		draftDelay = clampDelay(audioDelay ?? 0);
	}
	wasOpen = open;
});

// Transport-aware codec gating (C5): a codec the effective relay transport cannot
// carry renders DISABLED with a reason — never hidden. Effective protocol floors
// to `srtla` (the `resolveTransportToken` floor). FEDERATION FAIL-OPEN: with no
// config (standalone federation mount) there is no transport to gate against, so
// gating is off and every codec stays selectable (today's behavior).
const effectiveProtocol = $derived(config?.relay_protocol ?? 'srtla');
function codecAllowedForTransport(codec: string): boolean {
	if (!config) return true;
	const parsed = audioCodecSchema.safeParse(codec);
	return parsed.success && audioCodecAllowedForTransport(parsed.data, effectiveProtocol);
}

function updateCodec(codec: string): void {
	const parsed = audioCodecSchema.safeParse(codec);
	if (parsed.success) draftCodec = parsed.data;
}

// The ACTIVE audio source (effective override-or-config value from the caller).
// Federation-tolerant: `undefined` when `asrc` is absent from config.
const activeAudioSource = $derived(audioSource);

// Save gate: the audio-support gate + streaming lock. Source selection is no
// longer validated here (the Source section owns it), so no source-missing block.
const saveDisabled = $derived(!hasAudioSupport || isStreaming);

// Reason for the locked codec select: streaming (cannot apply without a restart)
// or no active source yet. Mirrors the Select.Root `disabled` condition.
const codecHasSource = $derived(audioEmbeddedActive || Boolean(activeAudioSource));
const codecDisabledReason = $derived(
	isStreaming
		? $LL.settings.codecDisabledReason.streaming()
		: !codecHasSource
			? $LL.settings.codecDisabledReason.noSource()
			: undefined,
);

function clampDelay(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(DELAY_MIN, Math.min(DELAY_MAX, value));
}

// i18n key resolver (mirrors the EncoderDialog helper) — lets the pure
// sourceSummary helpers resolve localized keys without a store/rune dependency.
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// Resolved-audio display (single owner): an active Auto selection surfaces
// "Auto → device"; the embedded reason surfaces the embedded state.
const resolvedAudio = $derived(
	resolvedAudioLabel({ asrc: activeAudioSource }, getStatus(), audioSourceEntries, t),
);

// READ-ONLY label for the active audio source: the embedded-stream state, the
// resolved "Auto → device" preview, an em-dash for an unresolved Auto (old
// backend), the resolved device/pseudo-source label, or a calm "none" fallback
// when `asrc` is absent (federation tolerance).
const activeAudioSourceLabel = $derived.by(() => {
	if (audioEmbeddedActive || resolvedAudio.embedded) return $LL.live.source.audioEmbedded();
	if (resolvedAudio.current) return resolvedAudio.current;
	if (activeAudioSource === AUDIO_SOURCE_AUTO) return '\u2014';
	if (!activeAudioSource) return $LL.settings.noAudioSourceSelected();
	const entry = audioSourceEntries.find((e) => e.id === activeAudioSource);
	return entry ? audioSourceLabel(entry, t) : activeAudioSource;
});
const codecTriggerLabel = $derived(
	draftCodec && audioCodecs
		? (audioCodecs[draftCodec]?.name ?? $LL.settings.selectAudioCodec())
		: $LL.settings.selectAudioCodec(),
);

async function handleSave() {
	if (saveDisabled) return;
	// Codec + delay ONLY — `asrc` is NEVER in this payload (the Source section
	// is the sole `asrc` writer).
	const values: AudioConfigValues = {
		acodec: draftCodec ?? 'aac',
		delay: draftDelay,
	};
	// Optimistic local commit so the Live summary updates immediately…
	onSave?.(values);
	// …then persist via the dedicated config RPC (no stream restart). Lock each
	// changed field BEFORE the RPC so a stale echo can't revert the edit, and
	// release after it settles (resolve or reject) to avoid a permanent lock.
	const input = { acodec: values.acodec, delay: values.delay };
	const fields = Object.entries(input).filter(([, value]) => value !== undefined);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await (hostAdapter?.setConfig(input) ?? rpc.streaming.setConfig(input));
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}
</script>

<AppDialog
	bind:open
	icon={Volume2}
	onPrimary={handleSave}
	primaryDisabled={saveDisabled}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.general.audioSettings()}
>
	<AudioDialogContent
		{gateState}
		{isStreaming}
		onOpenEncoder={onOpenEncoder ? () => { open = false; onOpenEncoder(); } : undefined}
		{audioEmbeddedComingSoon}
		{activeAudioSourceLabel}
		{draftCodec}
		codecOptions={audioCodecs}
		{codecHasSource}
		{codecDisabledReason}
		{codecTriggerLabel}
		isCodecAllowed={codecAllowedForTransport}
		onCodecChange={updateCodec}
		{draftDelay}
		delayMin={DELAY_MIN}
		delayMax={DELAY_MAX}
		delayStep={DELAY_STEP}
		onDelayChange={(value) => (draftDelay = value)}
	/>
</AppDialog>
