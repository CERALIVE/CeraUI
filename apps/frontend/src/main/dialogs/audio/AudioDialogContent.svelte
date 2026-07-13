<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AudioCodec } from '@ceraui/rpc/schemas';
import { Volume2 } from '@lucide/svelte';

import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
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
}

let {
	gateState, isStreaming, onOpenEncoder, audioEmbeddedComingSoon,
	activeAudioSourceLabel, draftCodec, codecOptions, codecHasSource,
	codecDisabledReason, codecTriggerLabel, isCodecAllowed, onCodecChange,
	draftDelay, delayMin, delayMax, delayStep, onDelayChange,
}: Props = $props();
</script>

{#if gateState === 'no-pipeline'}
	<div class="bg-muted/50 flex flex-col items-center gap-3 rounded-lg px-4 py-5 text-center">
		<p class="text-muted-foreground text-sm">{$LL.settings.selectPipelineFirst()}</p>
		{#if onOpenEncoder}
			<Button data-testid="audio-gate-open-encoder" onclick={onOpenEncoder} size="sm" variant="outline">{$LL.settings.encoderSettings()}</Button>
		{/if}
	</div>
{:else if gateState === 'no-audio-support'}
	<div class="border-destructive/20 bg-destructive/5 rounded-lg border px-4 py-3">
		<h4 class="text-destructive text-sm font-medium">{$LL.settings.noAudioSettingSupport()}</h4>
		<p class="text-destructive/80 mt-1 text-xs">{$LL.settings.selectedPipelineNoAudio()}</p>
	</div>
{:else}
	<div class="space-y-5">
		{#if isStreaming}
			<div class="bg-muted/60 rounded-lg border px-4 py-2.5"><p class="text-muted-foreground text-xs">{$LL.settings.changeBitrateNotice()}</p></div>
		{/if}
		<div class="space-y-2">
			<div class="flex items-center gap-1">
				<Label class="text-sm font-medium">{$LL.settings.activeAudioSource()}</Label>
				<InfoPopover body={$LL.live.education.field.audio.body()} testId="info-audio-source" title={$LL.live.education.field.audio.title()} />
				{#if audioEmbeddedComingSoon}<ComingSoon debtId="TD-embedded-audio" label={$LL.live.comingSoon.embeddedAudio()} />{/if}
			</div>
			<div class="bg-muted/40 flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" data-testid="audio-source-active">
				<span class="flex items-center gap-2"><Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" /><span class="text-sm">{activeAudioSourceLabel}</span></span>
				<span class="text-muted-foreground shrink-0 text-xs">{$LL.settings.changeAudioSourceHint()}</span>
			</div>
		</div>
		<div class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<div class="flex items-center gap-1"><Label class="text-sm font-medium" for="audioCodec">{$LL.settings.audioCodec()}</Label><InfoPopover body={$LL.live.education.field.codec.body()} testId="info-audio-codec" title={$LL.live.education.field.codec.title()} /></div>
				{#if isStreaming}<ComingSoon debtId="TD-live-audio-codec" />{/if}
			</div>
			<Select.Root disabled={isStreaming || !codecHasSource} onValueChange={onCodecChange} type="single" value={draftCodec}>
				<Select.Trigger id="audioCodec" class="w-full" title={codecDisabledReason}>{codecTriggerLabel}</Select.Trigger>
				<Select.Content><Select.Group>
					{#each Object.entries(codecOptions ?? {}) as [codec, meta] (codec)}
						{@const allowed = isCodecAllowed(codec)}
						<Select.Item disabled={!allowed} label={meta.name} title={allowed ? undefined : $LL.settings.audioCodecUnsupportedTransport()} value={codec}></Select.Item>
					{/each}
				</Select.Group></Select.Content>
			</Select.Root>
		</div>
		<AudioDelayControl value={draftDelay} min={delayMin} max={delayMax} step={delayStep} onChange={onDelayChange} />
	</div>
{/if}
