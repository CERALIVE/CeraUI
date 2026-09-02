<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { AudioBackend, AudioCodec } from '@ceraui/rpc/schemas';
import { CircleAlert, Volume2 } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import InlineSpinner from '$lib/components/custom/InlineSpinner.svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import type { AudioBackendView } from '$lib/streaming/audioBackend';
import type { AudioGateState } from '$lib/streaming/audioGate';
import AudioDelayControl from './AudioDelayControl.svelte';

interface CodecOption {
	readonly name: string;
}

interface Props {
	gateState: AudioGateState;
	isStreaming: boolean;
	onOpenEncoder?: () => void;
	audioEmbeddedComingSoon: boolean;
	activeAudioSourceLabel: string;
	/** Raw hardware descriptor behind the active source — bus path, speed, full name. */
	activeAudioSourceDetail?: string;
	/** The active source is a pluggable external accessory (read-only marker). */
	activeAudioSourceExternal?: boolean;
	draftCodec?: AudioCodec;
	codecOptions?: Readonly<Record<string, CodecOption>>;
	codecHasSource: boolean;
	codecDisabledReason?: string;
	codecTriggerLabel: string;
	isCodecAllowed: (codec: string) => boolean;
	onCodecChange: (codec: string) => void;
	draftDelay: number;
	delayMin: number;
	delayMax: number;
	delayStep: number;
	onDelayChange: (value: number) => void;
	/**
	 * The engine audio-backend offering. ADDITIVE-OPTIONAL: an omitted view (and
	 * a view whose mode is `absent`) renders ZERO nodes, so a host or a caller
	 * that never passes one is byte-identical to the pre-selector dialog.
	 */
	backendView?: AudioBackendView;
	/** The backend a write is in flight for — the SOLE optimistic element. */
	backendPending?: AudioBackend;
	/** An already-localized refusal sentence for the explicit error band. */
	backendError?: string;
	onBackendChange?: (backend: AudioBackend) => void;
}

let {
	gateState, isStreaming, onOpenEncoder, audioEmbeddedComingSoon,
	activeAudioSourceLabel, activeAudioSourceDetail, activeAudioSourceExternal = false,
	draftCodec, codecOptions, codecHasSource,
	codecDisabledReason, codecTriggerLabel, isCodecAllowed, onCodecChange,
	draftDelay, delayMin, delayMax, delayStep, onDelayChange,
	backendView, backendPending, backendError, onBackendChange,
}: Props = $props();

// The section renders only when the ENGINE stated a capability. `absent` is not
// a disabled state: nothing is being withheld, so there is nothing to explain.
const showBackend = $derived(backendView !== undefined && backendView.mode !== 'absent');
const backendDisabledReason = $derived(
	backendView?.disabledReasonKey ? m[backendView.disabledReasonKey]() : undefined,
);
</script>

{#if gateState === 'no-pipeline'}
	<div class="bg-muted/50 flex flex-col items-center gap-3 rounded-lg px-4 py-5 text-center">
		<p class="text-muted-foreground text-sm">{m["settings.selectPipelineFirst"]()}</p>
		{#if onOpenEncoder}
			<Button data-testid="audio-gate-open-encoder" onclick={onOpenEncoder} size="sm" variant="outline">{m["settings.encoderSettings"]()}</Button>
		{/if}
	</div>
{:else if gateState === 'no-audio-support'}
	<div class="border-destructive/20 bg-destructive/5 rounded-lg border px-4 py-3">
		<h4 class="text-destructive text-sm font-medium">{m["settings.noAudioSettingSupport"]()}</h4>
		<p class="text-destructive/80 mt-1 text-xs">{m["settings.selectedPipelineNoAudio"]()}</p>
	</div>
{:else}
	<div class="space-y-5">
		{#if isStreaming}
			<div class="bg-muted/60 rounded-lg border px-4 py-2.5"><p class="text-muted-foreground text-xs">{m["settings.changeBitrateNotice"]()}</p></div>
		{/if}
		<div class="space-y-2">
			<div class="flex items-center gap-1">
				<Label class="text-sm font-medium">{m["settings.activeAudioSource"]()}</Label>
				<InfoPopover body={m["live.education.field.audio.body"]()} testId="info-audio-source" title={m["live.education.field.audio.title"]()} />
				{#if audioEmbeddedComingSoon}<ComingSoon debtId="TD-embedded-audio" label={m["live.comingSoon.embeddedAudio"]()} />{/if}
			</div>
			<div class="bg-muted/40 flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" data-testid="audio-source-active" title={activeAudioSourceDetail}>
				<span class="flex items-center gap-2">
					<Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
					<span class="text-sm">{activeAudioSourceLabel}</span>
					{#if activeAudioSourceExternal}
						<Badge
							data-testid="audio-device-external"
							label={m["settings.audioDeviceExternal"]()}
							size="micro"
							title={m["settings.audioDeviceExternalHint"]()}
							variant="info"
						/>
					{/if}
				</span>
				<span class="text-muted-foreground shrink-0 text-xs">{m["settings.changeAudioSourceHint"]()}</span>
			</div>
		</div>
		<div class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<div class="flex items-center gap-1"><Label class="text-sm font-medium" for="audioCodec">{m["settings.audioCodec"]()}</Label><InfoPopover body={m["live.education.field.codec.body"]()} testId="info-audio-codec" title={m["live.education.field.codec.title"]()} /></div>
				{#if isStreaming}<ComingSoon debtId="TD-live-audio-codec" />{/if}
			</div>
			<Select.Root disabled={isStreaming || !codecHasSource} onValueChange={onCodecChange} type="single" value={draftCodec}>
				<Select.Trigger id="audioCodec" class="w-full" title={codecDisabledReason}>{codecTriggerLabel}</Select.Trigger>
				<Select.Content><Select.Group>
					{#each Object.entries(codecOptions ?? {}) as [codec, meta] (codec)}
						{@const allowed = isCodecAllowed(codec)}
						<Select.Item disabled={!allowed} label={meta.name} title={allowed ? undefined : m["settings.audioCodecUnsupportedTransport"]()} value={codec}></Select.Item>
					{/each}
				</Select.Group></Select.Content>
			</Select.Root>
		</div>
		<AudioDelayControl value={draftDelay} min={delayMin} max={delayMax} step={delayStep} onChange={onDelayChange} />

		<!-- Engine audio backend. Last, behind a rule: codec and delay are what an
		     operator opens this dialog to change; which subsystem builds the audio
		     path is a platform decision they visit rarely. It writes on selection
		     (its own setConfig), so it is deliberately NOT behind the dialog's Save
		     button — that button commits the codec/delay DRAFT, and folding a
		     next-session platform switch into it would make one press mean two
		     unrelated things. -->
		{#if showBackend && backendView}
			<div class="space-y-2 border-t pt-4" data-testid="audio-backend">
				<div class="flex items-center gap-1">
					<Label class="text-sm font-medium">{m["settings.audioBackend.label"]()}</Label>
					<InfoPopover
						body={m["settings.audioBackend.infoBody"]()}
						testId="info-audio-backend"
						title={m["settings.audioBackend.infoTitle"]()}
					/>
					{#if backendPending}
						<InlineSpinner
							data-testid="audio-backend-applying"
							label={m["settings.audioBackend.applying"]()}
							labelHidden={true}
						/>
					{/if}
				</div>
				<div
					aria-label={m["settings.audioBackend.label"]()}
					class="flex flex-wrap gap-1.5"
					data-mode={backendView.mode}
					role="radiogroup"
				>
					{#each backendView.options as option (option.backend)}
						{@const locked = backendView.mode === 'single' || backendPending !== undefined}
						<button
							aria-checked={option.selected}
							class="min-h-11 rounded-md border px-3 py-1 text-xs font-medium transition-colors {option.selected
								? 'border-primary bg-primary/10 text-primary'
								: 'border-border text-muted-foreground hover:bg-accent/50'} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
							data-active={option.active}
							data-backend={option.backend}
							data-selected={option.selected}
							data-testid={`audio-backend-${option.backend}`}
							disabled={locked || option.selected}
							onclick={() => onBackendChange?.(option.backend)}
							role="radio"
							title={backendDisabledReason}
							type="button"
						>
							{option.label}
						</button>
					{/each}
				</div>
				{#if backendView.active}
					<p class="text-muted-foreground text-xs" data-testid="audio-backend-active">
						<span>{m["settings.audioBackend.activeLabel"]()}</span>
						<span class="text-foreground font-mono">{backendView.options.find((o) => o.active)?.label ?? backendView.active}</span>
					</p>
				{/if}
				{#if backendDisabledReason}
					<p class="text-muted-foreground text-xs" data-testid="audio-backend-single-reason">{backendDisabledReason}</p>
				{:else if backendView.appliesNextStart}
					<p class="text-muted-foreground text-xs" data-testid="audio-backend-next-start">{m["settings.audioBackend.nextStart"]()}</p>
				{/if}
				<!-- A stored pick this engine build no longer advertises. It is STATED,
				     never offered — the radiogroup above is the advertised set alone. -->
				{#if backendView.staleSelection}
					<p
						class="border-status-warning/40 bg-status-warning/10 rounded-lg border px-3 py-2 text-xs"
						data-testid="audio-backend-stale"
						role="status"
					>
						{m["settings.audioBackend.staleSelection"]()}
					</p>
				{/if}
				<!-- The typed refusal, rendered as an EXPLICIT band beside the control
				     that was refused — the preview-error honesty rule: an operator on
				     the kiosk touchscreen must never be left with a control that looks
				     busy or unchanged with no stated outcome. -->
				{#if backendError}
					<p
						class="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
						data-testid="audio-backend-error"
						role="alert"
					>
						<CircleAlert aria-hidden={true} class="mt-0.5 size-3.5 shrink-0" />
						<span>{backendError}</span>
					</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}
