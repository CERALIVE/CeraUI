<!--
  SourceSection.svelte — unified Source surface for the Live destination (Task 8).

  Brings the hotplug VIDEO input picker and the pipeline-reported AUDIO source
  into one coherent section, fronted by a compact capability summary
  (res / fps / codec / audio) derived from the engine `get-capabilities`
  broadcast, and an explicit lost-device explanation (badge + body + recovery
  hint) instead of a silent "Lost" label.

  Composition, not a new subsystem: the video block is the existing InputPicker;
  the audio block reuses the pipeline source list. Audio selection is PRE-START
  only — live audio switching is gated (Task 10), so while streaming (or with a
  single source) the audio source renders READ-ONLY, never a misleading dropdown.

  Presentational: every datum + handler is a prop, so it renders deterministically
  under vitest with no subscription/runtime dependency.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	CaptureDevice,
	CapabilitiesMessage,
	ConfigMessage,
	NetworkIngest,
	Pipelines,
} from '@ceraui/rpc/schemas';
import { VIDEO_SOURCE_LABELS } from '@ceraui/rpc/schemas';
import { Check, Copy, QrCode, Radio, TriangleAlert, Video, Volume2 } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import InputPicker from '$lib/components/custom/InputPicker.svelte';
import SourcePreference from '$lib/components/custom/SourcePreference.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import * as Select from '$lib/components/ui/select';
import { generateDeviceAccessQr } from '$lib/helpers/NetworkHelper';
import { deriveNetworkIngestRows } from '$lib/streaming/networkIngestRows';
import type { FailoverEvent } from '$lib/streaming/source-preference';
import {
	deriveActiveSummary,
	deriveCapabilitySummary,
	formatCodec,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
} from '$lib/streaming/sourceSummary';

interface Props {
	// ── Video (forwarded to InputPicker) ──
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	selectedInput?: string | undefined;
	isStreaming?: boolean;
	switchingInput?: string | undefined;
	/** Forwarded to InputPicker: gates the live audio-switch affordance (G2). */
	audioLiveSwitchEnabled?: boolean;
	/** Forwarded to InputPicker: field-sync key driving the audio-switch glyph. */
	audioLiveSwitchField?: string;
	onSelect?: (id: string) => void;
	onSwitch?: (id: string) => void;
	// ── Audio ──
	audioSources?: string[];
	selectedAudioSource?: string | undefined;
	onSelectAudioSource?: (id: string) => void;
	// ── Network-ingest gateways as first-class sources (Task 12) ──
	/** `status.network_ingest` — a `null`/absent protocol renders no row. */
	networkIngest?: NetworkIngest | null | undefined;
	/** `getPipelines()?.pipelines` — resolves the pipeline id per protocol. */
	pipelines?: Pipelines | undefined;
	/** The currently-selected `config.pipeline` (drives the "selected" state). */
	selectedPipeline?: string | undefined;
	/** Selecting a network-ingest source sets `config.pipeline` (owned by LiveView). */
	onSelectNetworkIngest?: (pipelineId: string) => void;
	// ── Capability summary ──
	capabilities?: CapabilitiesMessage | undefined;
	// ── Active-config truth (Todo 23) ──
	/** Saved config — the IDLE source of res/fps/codec/transport. */
	config?: ConfigMessage | undefined;
	/** Engine `active_encode` — WINS while streaming (engine truth over requested). */
	activeEncode?: ActiveEncode | null | undefined;
	// ── Source preference + fallback state (Task 11) ──
	sourceOrder?: string[];
	sourceFailover?: FailoverEvent | null;
	sourcePreferenceField?: string;
	onReorderSource?: (id: string, direction: 'up' | 'down') => void;
}

let {
	devices = [],
	activeInput,
	selectedInput,
	isStreaming = false,
	switchingInput,
	audioLiveSwitchEnabled = false,
	audioLiveSwitchField,
	onSelect,
	onSwitch,
	audioSources = [],
	selectedAudioSource,
	onSelectAudioSource,
	networkIngest,
	pipelines,
	selectedPipeline,
	onSelectNetworkIngest,
	capabilities,
	config,
	activeEncode,
	sourceOrder = [],
	sourceFailover = null,
	sourcePreferenceField = 'source_preference',
	onReorderSource,
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
const activeSummary = $derived(deriveActiveSummary(config, activeEncode, capabilities));
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

// Audio source: single → read-only, multiple → selectable (pre-start only).
const audioMode = $derived(resolveAudioSourceMode(audioSources));
const displayedAudioSource = $derived(
	resolveDisplayedAudioSource(selectedAudioSource, audioSources),
);
// Configured source the pipeline no longer reports: always keep it a VISIBLE
// (marked-unavailable) entry so the control never shows an orphan value.
const notAvailableAudioSource = $derived(
	displayedAudioSource && !audioSources.includes(displayedAudioSource)
		? displayedAudioSource
		: undefined,
);
// Live audio switch is gated (Task 10): force read-only while streaming.
const audioReadOnly = $derived(audioMode === 'single' || isStreaming);
const audioComingSoon = $derived(isStreaming && audioMode === 'multiple');

// Lost-device explanation: any reported device that vanished mid-session. The
// active source being lost is the critical case but any lost device warrants
// the explicit explanation + recovery hint (not just the per-row "Lost" badge).
const lostDevices = $derived(devices.filter((d) => d.lost));
const hasLostDevice = $derived(lostDevices.length > 0);

// ── Network-ingest gateways as first-class sources (Task 12) ──
// The rtmp/srt LAN ingest gateways are surfaced as selectable source rows carrying
// their live gateway data. The structural derivation (availability verdict via the
// shared pipelineAvailability rule, addressless state, embedded-audio flag) comes
// from `deriveNetworkIngestRows` — the SAME truth NetworkIngestSection reads — so
// neither surface re-derives the gateway rule inline. This block only maps the
// structural row onto i18n copy.
const networkIngestRows = $derived.by(() =>
	deriveNetworkIngestRows({
		networkIngest,
		pipelines,
		capabilities,
		selectedPipeline,
		isStreaming,
	}).map((row) => {
		const label = VIDEO_SOURCE_LABELS[row.protocol] ?? row.protocol;
		let reason = '';
		if (row.addressless) {
			reason = $LL.live.networkIngest.noAddress({ protocol: label });
		} else if (row.gatewayBlocked) {
			reason = $LL.live.networkIngest.serviceInactive({ protocol: label });
		} else if (row.streamingLocked) {
			reason = $LL.live.networkIngest.streamingLocked();
		}
		return {
			...row,
			label,
			reason,
			statusLabel: row.addressless
				? $LL.live.networkIngest.noAddressStatus()
				: row.serviceActive
					? $LL.live.networkIngest.active()
					: $LL.live.networkIngest.inactive(),
			statusWarn: row.addressless || !row.serviceActive,
			// No url ⇒ nothing to encode into a QR or copy: suppress the panel.
			showInstructions: row.url !== null,
		};
	}),
);

// Per-protocol publish-instruction QR data URLs (URL only, never a secret) —
// mirrors NetworkIngestSection's effect so both render an identical QR.
let networkQrDataUrls = $state<Record<string, string>>({});
$effect(() => {
	let cancelled = false;
	const next: Record<string, string> = {};
	Promise.all(
		networkIngestRows.map(async (row) => {
			if (!row.url) return;
			try {
				next[row.protocol] = await generateDeviceAccessQr(row.url);
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

function selectNetworkIngest(row: { disabled: boolean; selected: boolean; pipelineId: string }): void {
	if (row.disabled || row.selected) return;
	onSelectNetworkIngest?.(row.pipelineId);
}

async function copyNetworkIngestUrl(url: string | null): Promise<void> {
	if (!url) return;
	try {
		await navigator.clipboard.writeText(url);
		toast.success($LL.live.networkIngest.copied());
	} catch {
		toast.error($LL.live.networkIngest.copyFailed());
	}
}
</script>

<Card.Root data-testid="source-section">
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

		<!-- Video input (hotplug picker, unchanged) -->
		<InputPicker
			{activeInput}
			{audioLiveSwitchEnabled}
			{audioLiveSwitchField}
			{devices}
			{isStreaming}
			{onSelect}
			{onSwitch}
			{selectedInput}
			{switchingInput}
		/>

		<!-- Operator-ordered source preference + fallback state (Task 11) -->
		{#if sourceOrder.length > 0}
			<div class="border-t pt-5">
				<SourcePreference
					{activeInput}
					{devices}
					failover={sourceFailover}
					onReorder={onReorderSource}
					order={sourceOrder}
					syncField={sourcePreferenceField}
				/>
			</div>
		{/if}

		<!-- Network-ingest gateways as first-class sources (Task 12): rtmp/srt LAN
		     ingest surfaced as selectable rows; availability routed through the shared
		     pipelineAvailability rule (never hidden). NetworkIngestSection stays the
		     detailed QR/instructions home; both read the SAME network_ingest truth. -->
		{#if networkIngestRows.length > 0}
			<div class="space-y-3 border-t pt-5" data-testid="source-network-ingest">
				<div class="flex items-center gap-1">
					<Radio aria-hidden={true} class="text-primary size-4 shrink-0" />
					<span class="text-sm font-medium">{$LL.live.networkIngest.title()}</span>
					<InfoPopover
						body={$LL.live.networkIngest.infoBody()}
						testId="info-source-network-ingest"
						title={$LL.live.networkIngest.infoTitle()}
					/>
				</div>
				<p class="text-muted-foreground text-xs">{$LL.live.networkIngest.subtitle()}</p>

				<ul class="space-y-3">
					{#each networkIngestRows as row (row.protocol)}
						<li
							data-protocol={row.protocol}
							data-testid={`source-network-ingest-row-${row.protocol}`}
						>
							<button
								class="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors {row.selected
									? 'border-primary bg-primary/10'
									: 'border-border hover:bg-accent/50'} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
								data-selected={row.selected}
								data-testid={`source-network-ingest-select-${row.protocol}`}
								disabled={row.disabled}
								onclick={() => selectNetworkIngest(row)}
								title={row.reason || undefined}
								type="button"
							>
								<span class="flex min-w-0 items-center gap-2.5">
									<span
										aria-hidden={true}
										class="size-2 shrink-0 rounded-full {row.gatewayBlocked
											? 'bg-status-warning'
											: 'bg-primary'}"
										data-testid={`source-network-ingest-dot-${row.protocol}`}
										data-blocked={row.gatewayBlocked}
									></span>
									<span class="flex min-w-0 flex-col">
										<span class="truncate text-sm font-medium">{row.label}</span>
										<span
											class="text-xs {row.statusWarn
												? 'text-status-warning'
												: 'text-muted-foreground'}"
											data-testid={`source-network-ingest-status-${row.protocol}`}
										>
											{row.statusLabel}
										</span>
									</span>
								</span>
								<span class="flex shrink-0 items-center gap-1.5">
									{#if row.supportsAudio}
										<span
											class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
											data-testid={`source-network-audio-${row.protocol}`}
										>
											<Volume2 aria-hidden={true} class="size-3" />
											{$LL.live.networkIngest.includesAudio()}
										</span>
									{/if}
									{#if row.selected}
										<span
											class="text-primary inline-flex items-center gap-1 text-xs font-semibold"
										>
											<Check aria-hidden={true} class="size-4" />
											{$LL.live.networkIngest.selected()}
										</span>
									{/if}
								</span>
							</button>

							{#if row.reason}
								<p
									class="text-status-warning mt-1 text-xs"
									data-testid={`source-network-ingest-reason-${row.protocol}`}
								>
									{row.reason}
								</p>
							{/if}

							{#if row.showInstructions && row.url}
								<details class="group mt-1.5">
									<summary
										class="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs font-medium select-none"
										data-testid={`source-network-ingest-instructions-toggle-${row.protocol}`}
									>
										<QrCode aria-hidden={true} class="size-3.5" />
										{$LL.live.networkIngest.instructionsToggle()}
									</summary>
									<div
										class="bg-muted/40 mt-2 flex flex-col items-center gap-3 rounded-lg border p-4"
										data-testid={`source-network-ingest-instructions-${row.protocol}`}
									>
										{#if networkQrDataUrls[row.protocol]}
											<img
												class="size-40 rounded-md bg-white p-2"
												alt={$LL.live.networkIngest.qrLabel()}
												data-testid={`source-network-ingest-qr-${row.protocol}`}
												src={networkQrDataUrls[row.protocol]}
											/>
										{/if}
										<div class="flex w-full items-center gap-2">
											<!-- dir="ltr": the URL is always Latin/ASCII; never mirror it. -->
											<code
												class="bg-background min-w-0 flex-1 truncate rounded-md border px-2.5 py-2 font-mono text-xs"
												data-testid={`source-network-ingest-url-${row.protocol}`}
												dir="ltr"
											>
												{row.url}
											</code>
											<Button
												aria-label={$LL.live.networkIngest.copy()}
												data-testid={`source-network-ingest-copy-${row.protocol}`}
												onclick={() => copyNetworkIngestUrl(row.url)}
												size="icon"
												title={$LL.live.networkIngest.copy()}
												variant="outline"
											>
												<Copy class="size-4" />
											</Button>
										</div>
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

			{#if audioMode === 'none'}
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
						{displayedAudioSource ?? $LL.live.source.audioNone()}
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
							{displayedAudioSource ?? $LL.settings.selectAudioSource()}
						{/if}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each audioSources as source (source)}
								<Select.Item label={source} value={source}></Select.Item>
							{/each}
							{#if notAvailableAudioSource}
								<Select.Item
									label={`${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
									value={notAvailableAudioSource}
								></Select.Item>
							{/if}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
