<!--
  SourceSection.svelte — unified device-first source list (Task 13).

  ONE list rendering all four StreamSource origins from `getSources()`:
    • capture — a concrete engine device, shown by its REAL displayName under a
                kind icon (a RØDE UVC dongle shows "RØDE …" + a USB glyph, never the
                coarse "HDMI Capture" label — this is what kills the mislabel).
    • coarse  — a legacy / no-device-yet capability source: its labelKey-translated
                label, FULLY selectable (the old pipeline-picker behavior surfaced
                through the unified list).
    • virtual — the single Test-pattern row (exactly once).
    • network — an rtmp/srt LAN ingest source with URL + QR/copy affordances,
                disabled-with-reason from `source.available` / `source.unavailableReason`
                (T2 routed that verdict through pipelineAvailability — NEVER re-derived
                here).

  Selecting any row writes `config.source` through the standard per-field-sync lock
  (beginFieldSync → setConfig → markFieldApplied with `result.applied`); the backend
  (T3) resolves the source id to the engine pipeline / input. Source PRIORITY is an
  inline reorder affordance rendered on capture rows only, and only when two or more
  capture sources exist (SourcePreference folded in — the separate card is gone). A
  lost capture device renders its state from `source.lost`.

  The audio selector block (embedded / read-only / selectable / none) stays exactly
  as before — audio devices are filtered out of `sources` by the backend, so this is
  the ONLY audio surface here.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	CaptureStreamSource,
	ConfigMessage,
	DeviceKind,
	NetworkStreamSource,
	SourcesMessage,
	StreamSource,
} from '@ceraui/rpc/schemas';
import {
	Cable,
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	QrCode,
	Radio,
	SquareDashed,
	TriangleAlert,
	Usb,
	Video,
	Volume2,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import FieldSyncIndicator from '$lib/components/custom/FieldSyncIndicator.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import * as Select from '$lib/components/ui/select';
import { generateDeviceAccessQr } from '$lib/helpers/NetworkHelper';
import { rpc } from '$lib/rpc';
import {
	beginFieldSync,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from '$lib/rpc/field-sync-state.svelte';
import { AUDIO_SOURCE_AUTO } from '@ceraui/rpc/schemas';
import {
	audioSourceLabel,
	deriveActiveSummary,
	deriveCapabilitySummary,
	formatCodec,
	groupAudioSources,
	resolveAudioSourceList,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
	type ResolvedAudioStatus,
	resolvedAudioLabel,
	withAutoAudioEntry,
} from '$lib/streaming/sourceSummary';

interface Props {
	// ── Unified device-first source list (T6 getSources()) ──
	sources?: SourcesMessage | undefined;
	// ── Active-config truth — `config.source` is the selected source id ──
	config?: ConfigMessage | undefined;
	/** Engine `active_encode` — WINS while streaming (engine truth over requested). */
	activeEncode?: ActiveEncode | null | undefined;
	// ── Capability summary ──
	capabilities?: CapabilitiesMessage | undefined;
	isStreaming?: boolean;
	// ── Source PRIORITY (capture rows only) — LiveView owns the source_preference write ──
	/** Persisted preference order of capture input_ids (reconciled by LiveView). */
	sourceOrder?: string[];
	/** Field-sync key driving the reorder "saving" glyph. */
	sourcePreferenceField?: string;
	onReorderSource?: (id: string, direction: 'up' | 'down') => void;
	// ── Live input switch (capture rows, streaming only) — LiveView owns the RPC ──
	/** Engine `active_input` — the capture source the engine is currently running. */
	activeInput?: string | undefined;
	/** The capture source with an in-flight live switch (optimistic latch). */
	switchingInput?: string | undefined;
	/** Dispatch a live input switch (streaming-only capture-row affordance). */
	onSwitch?: (id: string) => void;
	// ── Audio (selection write owned by LiveView) ──
	audioSources?: string[];
	/** Typed audio-source model (status.audio_sources); falls back to `audioSources`. */
	audioSourceList?: AudioSource[] | undefined;
	selectedAudioSource?: string | undefined;
	onSelectAudioSource?: (id: string) => void;
	/** T5 auto-resolution fields off the `status` broadcast (resolved/pending/embedded). */
	audioStatus?: ResolvedAudioStatus | undefined;
}

let {
	sources,
	config,
	activeEncode,
	capabilities,
	isStreaming = false,
	sourceOrder = [],
	sourcePreferenceField = 'source_preference',
	onReorderSource,
	activeInput,
	switchingInput,
	onSwitch,
	audioSources = [],
	audioSourceList,
	selectedAudioSource,
	onSelectAudioSource,
	audioStatus,
}: Props = $props();

// Capability summary (res / fps / codec / audio) — compact, telemetry-style.
const summary = $derived(deriveCapabilitySummary(capabilities, config));
const capChips = $derived.by(() => {
	if (!summary) return [] as string[];
	const chips: string[] = [];
	if (summary.maxResolution) chips.push(summary.maxResolution);
	if (summary.maxFramerate) chips.push(`${summary.maxFramerate}fps`);
	for (const codec of summary.codecs) chips.push(formatCodec(codec));
	return chips;
});

// Active-config truth (Todo 23): engine `active_encode` while streaming, else the
// saved config. Distinct from the capability chips above — these are settings.
const activeSummary = $derived(
	deriveActiveSummary(config, activeEncode, capabilities, sources?.sources),
);
const activeParts = $derived.by(() => {
	const parts: string[] = [];
	if (activeSummary.source) parts.push(activeSummary.source);
	if (activeSummary.resolution) parts.push(activeSummary.resolution);
	if (typeof activeSummary.framerate === 'number') parts.push(`${activeSummary.framerate}fps`);
	if (activeSummary.codec) parts.push(activeSummary.codec);
	parts.push(activeSummary.transport);
	return parts;
});
const hasActiveConfig = $derived(
	activeSummary.live ||
		Boolean(activeSummary.source || activeSummary.resolution || activeSummary.codec),
);

// i18n key resolver (mirrors AudioDialog) — resolves a dotted labelKey to a locale
// string without a store dep, with safe key-passthrough on a miss.
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

// ── Unified source list (Task 13) ──────────────────────────────────────────
// Every source in backend (`caps.sources`) order, with the capture slots refilled
// in the operator's preference order so a capture row never jumps past a
// coarse/network row. The reorder affordance touches ONLY the capture ordering.
const captureSources = $derived(
	(sources?.sources ?? []).filter(
		(s): s is CaptureStreamSource => s.origin === 'capture',
	),
);
const canReorder = $derived(captureSources.length >= 2);
const orderedCaptures = $derived.by(() => {
	const rank = new Map(sourceOrder.map((id, i) => [id, i] as const));
	return [...captureSources].sort(
		(a, b) =>
			(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
	);
});
const captureRank = $derived(
	new Map(orderedCaptures.map((s, i) => [s.id, i] as const)),
);
const orderedSources = $derived.by(() => {
	const all = sources?.sources ?? [];
	let ci = 0;
	return all.map((s) => (s.origin === 'capture' ? (orderedCaptures[ci++] ?? s) : s));
});
const hasSources = $derived(orderedSources.length > 0);

// Lost-device explanation: any reported capture device that vanished mid-session.
const lostCaptures = $derived(captureSources.filter((s) => s.lost === true));
const hasLostDevice = $derived(lostCaptures.length > 0);

// A row is unselectable when a network gateway is down (consume source.available —
// never re-derive it) or a capture device was unplugged (lost).
function rowDisabled(source: StreamSource): boolean {
	if (source.available === false) return true;
	return source.origin === 'capture' && source.lost === true;
}

// The disabled reason surfaced as the row `title` (i18n dot-path from the source).
function rowReason(source: StreamSource): string | undefined {
	if (source.origin === 'capture' && source.lost === true) {
		return $LL.live.source.lostBody();
	}
	return source.unavailableReason ? t(source.unavailableReason) : undefined;
}

// Row label: capture shows its REAL hardware name; every other origin shows its
// translated labelKey (the pipeline-picker copy surfaced through the unified list).
function rowLabel(source: StreamSource): string {
	return source.origin === 'capture' ? source.displayName : t(source.labelKey);
}

// Capture kind → coarse device family (drives the icon + the kind badge). A UVC
// dongle (`uvc_h264`) is USB family, so its badge reads "USB" — never "HDMI".
type KindFamily = 'hdmi' | 'usb' | 'network' | 'other';
function kindFamily(kind: DeviceKind): KindFamily {
	if (kind === 'hdmi') return 'hdmi';
	if (kind === 'network') return 'network';
	if (
		kind === 'usb' ||
		kind === 'uvc_h264' ||
		kind === 'uvc_h265' ||
		kind === 'mjpeg' ||
		kind === 'camlink'
	) {
		return 'usb';
	}
	return 'other';
}
const KIND_ICON = { hdmi: Cable, usb: Usb, network: Radio, other: Video } as const;
function kindLabel(kind: DeviceKind): string {
	return t(`live.inputPicker.groups.${kindFamily(kind)}`);
}
function rowIcon(source: StreamSource) {
	if (source.origin === 'capture') return KIND_ICON[kindFamily(source.kind)];
	if (source.origin === 'virtual') return SquareDashed;
	if (source.origin === 'network') return Radio;
	return Video;
}

// ── Source selection: the ONE write, via the standard per-field-sync lock ────
// Selecting any row persists `config.source`; the backend (T3) resolves the id to
// the engine pipeline / selected_video_input. The lock releases to the SERVER-
// applied value (result.applied), never the optimistic id.
const SOURCE_FIELD = 'source';
async function handleSelectSource(source: StreamSource): Promise<void> {
	if (rowDisabled(source) || source.id === config?.source) return;
	beginFieldSync(SOURCE_FIELD, source.id);
	markFieldApplying(SOURCE_FIELD);
	try {
		const result = await rpc.streaming.setConfig({ source: source.id });
		// Release the lock to the SERVER-APPLIED value (`result.applied.source`),
		// never the optimistic id we sent. A rejected setConfig (`success:false`,
		// e.g. `{error:'unknown_source'}` — which carries no `applied.source`) or a
		// success that omits the field is NOT a confirmed apply: revert the lock to
		// the prior config value and surface the same calm error the catch path does.
		if (result.success && result.applied?.source !== undefined) {
			markFieldApplied(SOURCE_FIELD, result.applied.source);
		} else {
			markFieldFailed(SOURCE_FIELD, config?.source);
			toast.error($LL.notifications.saveFailed());
		}
	} catch {
		markFieldFailed(SOURCE_FIELD, config?.source);
		toast.error($LL.notifications.saveFailed());
	}
}

// Per-network-source publish-instruction QR data URLs (URL only, never a secret) —
// mirrors NetworkIngestSection's effect so both render an identical QR.
const networkSources = $derived(
	orderedSources.filter((s): s is NetworkStreamSource => s.origin === 'network'),
);
let networkQrDataUrls = $state<Record<string, string>>({});
$effect(() => {
	let cancelled = false;
	const next: Record<string, string> = {};
	Promise.all(
		networkSources.map(async (source) => {
			if (!source.url) return;
			try {
				next[source.id] = await generateDeviceAccessQr(source.url);
			} catch {
				// A QR failure just omits the image — the URL + copy still work.
			}
		}),
	).then(() => {
		if (!cancelled) networkQrDataUrls = next;
	});
	return () => {
		cancelled = true;
	};
});

async function copyNetworkIngestUrl(url: string | null): Promise<void> {
	if (!url) return;
	try {
		await navigator.clipboard.writeText(url);
		toast.success($LL.live.networkIngest.copied());
	} catch {
		toast.error($LL.live.networkIngest.copyFailed());
	}
}

// ── Audio source (unchanged states) ──────────────────────────────────────────
const audioMode = $derived(resolveAudioSourceMode(audioSources));
const displayedAudioSource = $derived(
	resolveDisplayedAudioSource(selectedAudioSource, audioSources),
);
const audioSourceEntries = $derived(resolveAudioSourceList(audioSourceList, audioSources));
const groupedAudio = $derived(groupAudioSources(audioSourceEntries));
// Picker entries carry the FE-injected Auto row FIRST (backend never emits it).
const pickerEntries = $derived(withAutoAudioEntry(audioSourceEntries));
const displayedAudioLabel = $derived.by(() => {
	const entry = pickerEntries.find((e) => e.id === displayedAudioSource);
	return entry ? audioSourceLabel(entry, t) : displayedAudioSource;
});
const notAvailableAudioSource = $derived(
	displayedAudioSource && !pickerEntries.some((e) => e.id === displayedAudioSource)
		? displayedAudioSource
		: undefined,
);
// Resolved-audio display (single owner): "Auto → device", pending, embedded.
const audioIsAuto = $derived(config?.asrc === AUDIO_SOURCE_AUTO);
const resolvedAudio = $derived(
	resolvedAudioLabel(config, audioStatus, audioSourceEntries, t),
);
// Live audio switch is gated (Task 10): force read-only while streaming.
const audioReadOnly = $derived(audioMode === 'single' || isStreaming);
const audioComingSoon = $derived(isStreaming && audioMode === 'multiple');

// Embedded network-ingest audio (Task 13): the ACTIVE source's `audioKind` is
// `embedded` (an rtmp/srt pipeline carries its audio muxed into the incoming
// stream). The engine only ROUTES it with the `network_embedded_audio` capability —
// with it, the audio source is read-only "Embedded audio"; without it, the legacy
// ALSA picker stays (the calm ComingSoon pill lives in IdleCockpit's roadmap, T12).
const activeSource = $derived(
	config?.source ? sources?.sources.find((s) => s.id === config.source) : undefined,
);
const audioEmbeddedActive = $derived(
	activeSource?.audioKind === 'embedded' && capabilities?.network_embedded_audio === true,
);
// Embedded state renders when the active source routes embedded audio OR the T5
// resolver reported the embedded reason (distinguishes the two null cases, R9-1).
const showEmbedded = $derived(audioEmbeddedActive || resolvedAudio.embedded);
</script>

<Card.Root data-testid="source-section" tabindex={-1}>
	<Card.Content class="space-y-5 p-4 sm:p-6">
		<!-- Section header + compact capability summary -->
		<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
			<div class="flex items-center gap-1">
				<Video aria-hidden={true} class="text-primary size-4 shrink-0" />
				<span class="text-sm font-semibold">{$LL.live.source.label()}</span>
				<InfoPopover
					body={$LL.live.education.field.source.body()}
					testId="info-source"
					title={$LL.live.education.field.source.title()}
				/>
			</div>
			{#if capChips.length || summary?.audioSupported}
				<div
					class="flex flex-wrap items-center gap-1.5"
					data-testid="source-capabilities"
					aria-label={$LL.live.source.capabilities()}
				>
					<span
						class="text-muted-foreground text-[0.65rem] font-semibold tracking-wide uppercase"
					data-testid="cap-device-max"
				>
					{$LL.live.source.sourceMax()}
					</span>
					<InfoPopover
						body={$LL.live.education.field.mode.body()}
						testId="info-mode"
						title={$LL.live.education.field.mode.title()}
					/>
					{#each capChips as chip (chip)}
						<span
							class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs"
						>
							{chip}
						</span>
					{/each}
					{#if summary?.audioSupported}
						<span
							class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
							data-testid="cap-audio"
						>
							<Volume2 aria-hidden={true} class="size-3" />
							{$LL.settings.audioSource()}
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Active-config line (Todo 23): what the device is DOING (engine truth while
		     streaming) or the saved config it will start with — visually distinct from
		     the capability chips above, which are the hardware ceiling, not settings. -->
		{#if hasActiveConfig}
			<div
				class="bg-muted/30 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2"
				data-testid="source-active-config"
			>
				<span
					class={`inline-flex items-center gap-1 text-xs font-semibold ${
						activeSummary.live ? 'text-primary' : 'text-muted-foreground'
					}`}
				>
					{#if activeSummary.live}
						<span aria-hidden={true} class="bg-primary size-1.5 rounded-full"></span>
					{/if}
					{activeSummary.live ? $LL.live.source.activeLive() : $LL.live.source.activeConfigured()}
				</span>
				<span class="text-foreground truncate font-mono text-sm" data-testid="active-config-value">
					{activeParts.join(' \u00b7 ')}
				</span>
			</div>
		{/if}

		<!-- Lost-device explanation: explicit badge + body + recovery hint -->
		{#if hasLostDevice}
			<div
				class="border-destructive/30 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3"
				data-testid="source-lost-banner"
				role="status"
			>
				<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-destructive text-sm font-medium">{$LL.live.source.lostTitle()}</p>
					<p class="text-muted-foreground text-xs">{$LL.live.source.lostBody()}</p>
				</div>
			</div>
		{/if}

		<!-- Unified device-first source list: capture / coarse / virtual / network rows.
		     Selecting a row persists config.source through the field-sync lock; a capture
		     row carries an inline reorder affordance when ≥2 capture sources exist. -->
		{#if hasSources}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="space-y-2" data-testid="source-list" tabindex={-1}>
				{#if canReorder}
					<div class="flex items-center justify-end">
						<FieldSyncIndicator
							appliedLabel={$LL.live.sourcePreference.sync.applied()}
							applyingLabel={$LL.live.sourcePreference.sync.applying()}
							failedLabel={$LL.live.sourcePreference.sync.failed()}
							field={sourcePreferenceField}
						/>
					</div>
				{/if}
				<ul class="space-y-2">
					{#each orderedSources as source (source.id)}
						{@const selected = config?.source === source.id}
						{@const disabled = rowDisabled(source)}
						{@const RowIcon = rowIcon(source)}
						{@const capRank = captureRank.get(source.id) ?? -1}
						<li
							data-testid={`source-row-${source.id}`}
							data-origin={source.origin}
							data-selected={selected}
						>
							<div class="flex items-center gap-2">
								<button
									class="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors {selected
										? 'border-primary bg-primary/10'
										: 'border-border hover:bg-accent/50'} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
									data-selected={selected}
									data-testid={source.origin === 'network'
										? `source-network-ingest-select-${source.requiresGateway}`
										: `source-select-${source.id}`}
									disabled={disabled || isStreaming}
									onclick={() => handleSelectSource(source)}
									title={disabled ? rowReason(source) : undefined}
									type="button"
								>
									<span class="flex min-w-0 items-center gap-2.5">
										<RowIcon
											aria-hidden={true}
											class="size-4 shrink-0 {selected ? 'text-primary' : 'text-muted-foreground'}"
										/>
										<span class="flex min-w-0 flex-col">
											<span class="truncate text-sm font-medium" data-testid={`source-row-name-${source.id}`}>
												{rowLabel(source)}
											</span>
											{#if source.origin === 'network'}
												<span
													class="text-xs {source.available ? 'text-muted-foreground' : 'text-status-warning'}"
													data-testid={`source-network-ingest-status-${source.requiresGateway}`}
												>
													{source.available
														? $LL.live.networkIngest.active()
														: $LL.live.networkIngest.inactive()}
												</span>
											{/if}
										</span>
									</span>
									<span class="flex shrink-0 items-center gap-1.5">
										{#if source.origin === 'capture'}
											<span
												class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium"
												data-source-kind={source.kind}
												data-testid={`source-kind-${source.id}`}
											>
												{kindLabel(source.kind)}
											</span>
											{#if source.lost}
												<span
													class="bg-destructive/15 text-destructive inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
												>
													<TriangleAlert aria-hidden={true} class="size-3" />
													{$LL.live.inputPicker.lost()}
												</span>
											{/if}
										{/if}
										{#if source.origin === 'network' && source.supportsAudio}
											<span
												class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
												data-testid={`source-network-audio-${source.requiresGateway}`}
											>
												<Volume2 aria-hidden={true} class="size-3" />
												{$LL.live.networkIngest.includesAudio()}
											</span>
										{/if}
										{#if selected}
											<span class="text-primary inline-flex items-center gap-1 text-xs font-semibold">
												<Check aria-hidden={true} class="size-4" />
												{$LL.live.inputPicker.selected()}
											</span>
										{/if}
									</span>
								</button>

								<!-- Capture-row trailing action. While STREAMING the row is a live
								     input switch (onSwitch → LiveView switchInput); while IDLE it is
								     the source-priority reorder affordance (≥2 capture sources). -->
								{#if source.origin === 'capture'}
									{#if isStreaming}
										<Button
											aria-label={`${$LL.live.inputPicker.switch()} \u2013 ${source.displayName}`}
											data-switch-input={source.id}
											disabled={source.id === activeInput ||
												source.id === switchingInput ||
												source.lost === true}
											onclick={() => onSwitch?.(source.id)}
											size="sm"
											variant={source.id === activeInput ? 'secondary' : 'default'}
										>
											{#if source.id === switchingInput}
												{$LL.live.inputPicker.switching()}
											{:else if source.id === activeInput}
												{$LL.live.inputPicker.active()}
											{:else}
												{$LL.live.inputPicker.switch()}
											{/if}
										</Button>
									{:else if canReorder}
										<div class="flex shrink-0 flex-col gap-1" data-testid={`source-reorder-${source.id}`}>
											<Button
												aria-label={$LL.live.sourcePreference.moveUp({ name: source.displayName })}
												class="size-9"
												data-move-up={source.id}
												disabled={capRank <= 0}
												onclick={() => onReorderSource?.(source.id, 'up')}
												size="icon"
												variant="outline"
											>
												<ChevronUp aria-hidden={true} class="size-4" />
											</Button>
											<Button
												aria-label={$LL.live.sourcePreference.moveDown({ name: source.displayName })}
												class="size-9"
												data-move-down={source.id}
												disabled={capRank === orderedCaptures.length - 1}
												onclick={() => onReorderSource?.(source.id, 'down')}
												size="icon"
												variant="outline"
											>
												<ChevronDown aria-hidden={true} class="size-4" />
											</Button>
										</div>
									{/if}
								{/if}
							</div>

							{#if source.origin === 'network' && !source.available}
								<p
									class="text-status-warning mt-1 text-xs"
									data-testid={`source-network-ingest-reason-${source.requiresGateway}`}
								>
									{rowReason(source)}
								</p>
							{/if}

							{#if source.origin === 'network' && source.url}
								<details class="group mt-1.5">
									<summary
										class="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs font-medium select-none"
										data-testid={`source-network-ingest-instructions-toggle-${source.requiresGateway}`}
									>
										<QrCode aria-hidden={true} class="size-3.5" />
										{$LL.live.networkIngest.instructionsToggle()}
									</summary>
									<div
										class="bg-muted/40 mt-2 flex flex-col items-center gap-3 rounded-lg border p-4"
										data-testid={`source-network-ingest-instructions-${source.requiresGateway}`}
									>
										{#if networkQrDataUrls[source.id]}
											<img
												class="size-40 rounded-md bg-white p-2"
												alt={$LL.live.networkIngest.qrLabel()}
												data-testid={`source-network-ingest-qr-${source.requiresGateway}`}
												src={networkQrDataUrls[source.id]}
											/>
										{/if}
										<div class="flex w-full items-center gap-2">
											<!-- dir="ltr": the URL is always Latin/ASCII; never mirror it. -->
											<code
												class="bg-background min-w-0 flex-1 truncate rounded-md border px-2.5 py-2 font-mono text-xs"
												data-testid={`source-network-ingest-url-${source.requiresGateway}`}
												dir="ltr"
											>
												{source.url}
											</code>
											<Button
												aria-label={$LL.live.networkIngest.copy()}
												data-testid={`source-network-ingest-copy-${source.requiresGateway}`}
												onclick={() => copyNetworkIngestUrl(source.url)}
												size="icon"
												title={$LL.live.networkIngest.copy()}
												variant="outline"
											>
												<Copy class="size-4" />
											</Button>
										</div>
										<p
											class="text-muted-foreground w-full text-xs leading-relaxed"
											data-testid={`source-network-ingest-codec-education-${source.requiresGateway}`}
										>
											{source.requiresGateway === 'rtmp'
												? $LL.live.networkIngest.codecEducation.rtmp()
												: $LL.live.networkIngest.codecEducation.srt()}
										</p>
									</div>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Audio source -->
		<div class="space-y-2 border-t pt-5" data-testid="source-audio">
			<div class="flex items-center gap-1">
				<Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
				<span class="text-sm font-medium">{$LL.settings.audioSource()}</span>
				<InfoPopover
					body={$LL.live.education.field.audio.body()}
					testId="info-audio"
					title={$LL.live.education.field.audio.title()}
				/>
				{#if audioComingSoon}
					<span
						class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
						title={$LL.live.comingSoon.hint()}
					>
						{$LL.live.comingSoon.label()}
					</span>
				{/if}
			</div>

			<!-- Resolved-audio preview (T6): while Auto is the active selection and the
			     source is NOT embedded, show what Auto resolved to ("Auto → device"),
			     or an em-dash when genuinely unresolved (old backend). -->
			{#if audioIsAuto && !showEmbedded}
				<p
					class="text-muted-foreground font-mono text-xs"
					data-testid="audio-source-auto-resolved"
				>
					{resolvedAudio.current ?? '\u2014'}
				</p>
			{/if}
			{#if resolvedAudio.pending !== undefined}
				<p class="text-status-info text-xs" data-testid="audio-follow-pending">
					{$LL.live.inputPicker.audioFollowsOnRestart()}
				</p>
			{/if}

			{#if showEmbedded}
				<!-- Engine routes the incoming stream's embedded audio — no ALSA pick. -->
				<div
					class="bg-muted/40 flex min-h-11 flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
					data-testid="audio-source-embedded"
				>
					<Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
					<span class="text-sm">{$LL.live.source.audioEmbedded()}</span>
				</div>
			{:else if audioMode === 'none'}
				<p class="text-muted-foreground text-sm" data-testid="audio-source-none">
					{$LL.live.source.audioNone()}
				</p>
			{:else if audioReadOnly}
				<!-- Single source, or streaming (live switch gated) → read-only. -->
				<div
					class="bg-muted/40 flex min-h-11 flex-wrap items-center gap-x-2 rounded-lg border px-3 py-2"
					data-testid="audio-source-readonly"
				>
					<span class="truncate font-mono text-sm">
						{displayedAudioLabel ?? $LL.live.source.audioNone()}
					</span>
					{#if notAvailableAudioSource}
						<span
							class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
							data-testid="audio-source-unavailable"
						>
							{$LL.settings.notAvailableAudioSource()}
						</span>
					{/if}
				</div>
			{:else}
				<!-- Multiple sources, pre-start → selectable. -->
				<Select.Root
					onValueChange={(value) => onSelectAudioSource?.(value)}
					type="single"
					value={selectedAudioSource}
				>
					<Select.Trigger
						class="min-h-11 w-full"
						data-testid="audio-source-select"
						id="sourceAudioSelect"
					>
						{#if notAvailableAudioSource}
							<span data-testid="audio-source-unavailable">
								{`${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
							</span>
						{:else}
							{displayedAudioLabel ?? $LL.settings.selectAudioSource()}
						{/if}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							<!-- Auto renders FIRST, above every device entry (FE-injected). -->
							<Select.Item
								data-testid="audio-source-auto-option"
								label={t('audio.sources.auto')}
								value={AUDIO_SOURCE_AUTO}
							></Select.Item>
							{#each groupedAudio.devices as entry (entry.id)}
								<Select.Item label={audioSourceLabel(entry, t)} value={entry.id}></Select.Item>
							{/each}
							{#if notAvailableAudioSource}
								<Select.Item
									label={`${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
									value={notAvailableAudioSource}
								></Select.Item>
							{/if}
						</Select.Group>
						{#if groupedAudio.pseudo.length > 0}
							<Select.Separator />
							<Select.Group>
								{#each groupedAudio.pseudo as entry (entry.id)}
									<Select.Item
										class="text-muted-foreground"
										label={audioSourceLabel(entry, t)}
										value={entry.id}
									></Select.Item>
								{/each}
							</Select.Group>
						{/if}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
