<!--
  CustomEndpointForm.svelte — the custom-receiver path of ServerDialog.

  Presentational + per-kind: ServerDialog owns the draft/derived state and the
  validate + save handlers; this component renders the address / port / stream-id
  / secret inputs the receiver `kind` calls for, the Validate action, and the
  multi-stage validation result (input→protocol→endpoint→dns→probe→ok) with an
  in-flight spinner.

  Field set is driven by the kind manifest (T1 `receiverKindManifest`):
   • srtla_custom / srt_custom → addr + port + stream id + secret
   • rist_custom               → addr + (even) port + stream id, even-port hint
  RIST simple-profile (librist) has no SRT-style passphrase — the backend RIST
  adapter ignores it — so the secret field is shown only for the passphrase-
  capable transports. Stream id never gates Save (`requiresStreamId` is advisory).
  Stage projection comes from the pure `deriveStageViews` reducer so the chips
  stay in lock-step with the Save gate.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { type ReceiverKind, receiverKindManifest, type RelayValidateStage } from '@ceraui/rpc/schemas';
import Check from '@lucide/svelte/icons/check';
import Circle from '@lucide/svelte/icons/circle';
import Loader2 from '@lucide/svelte/icons/loader-2';
import X from '@lucide/svelte/icons/x';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { type Validation, deriveStageViews } from '$lib/components/streaming/relay-validation';

interface Props {
	kind: ReceiverKind;
	isStreaming: boolean;
	addr: string;
	portStr: string;
	streamId: string;
	passphrase: string;
	addrError?: string;
	portError?: string;
	port: { min: number; max: number };
	validation: Validation;
	canValidate: boolean;
	onAddr: (value: string) => void;
	onPort: (value: string) => void;
	onStreamId: (value: string) => void;
	onPassphrase: (value: string) => void;
	onValidate: () => void;
}

let {
	kind,
	isStreaming,
	addr,
	portStr,
	streamId,
	passphrase,
	addrError,
	portError,
	port,
	validation,
	canValidate,
	onAddr,
	onPort,
	onStreamId,
	onPassphrase,
	onValidate,
}: Props = $props();

const manifest = $derived(receiverKindManifest(kind));
const showStreamId = $derived(manifest.fields.includes('streamid'));
// RIST simple-profile carries no passphrase; the secret input is for the
// SRT-family transports only.
const showSecret = $derived(kind === 'srtla_custom' || kind === 'srt_custom');
const evenPortRequired = $derived(manifest.requiresEvenPort);

const stageViews = $derived(deriveStageViews(validation));

function stageLabel(stage: RelayValidateStage): string {
	return $LL.settings.validateStages[stage]();
}
</script>

<div class="space-y-2">
	<Label class="text-sm font-medium" for="srtla-addr">
		{kind === 'rist_custom' ? $LL.settings.receiverAddress() : $LL.settings.srtlaServerAddress()}
	</Label>
	<Input
		id="srtla-addr"
		aria-invalid={addrError ? 'true' : undefined}
		class="font-mono"
		disabled={isStreaming}
		oninput={(e) => onAddr(e.currentTarget.value)}
		placeholder={$LL.settings.placeholders.srtlaServerAddress()}
		value={addr}
	/>
	{#if addrError}
		<p class="text-destructive text-sm">{addrError}</p>
	{/if}
</div>

<div class="space-y-2">
	<Label class="text-sm font-medium" for="srtla-port">
		{kind === 'rist_custom' ? $LL.settings.receiverPort() : $LL.settings.srtlaServerPort()}
	</Label>
	<Input
		id="srtla-port"
		aria-invalid={portError ? 'true' : undefined}
		class="font-mono"
		disabled={isStreaming}
		inputmode="numeric"
		max={port.max}
		min={port.min}
		oninput={(e) => onPort(e.currentTarget.value)}
		placeholder={$LL.settings.placeholders.srtlaServerPort()}
		type="number"
		value={portStr}
	/>
	{#if evenPortRequired}
		<p class="text-muted-foreground text-xs" data-testid="rist-even-port-hint">
			{$LL.settings.ristEvenPortHint()}
		</p>
	{/if}
	{#if portError}
		<p class="text-destructive text-sm">{portError}</p>
	{/if}
</div>

{#if showStreamId}
	<div class="space-y-2">
		<Label class="text-sm font-medium" for="srt-streamid">
			{$LL.settings.srtStreamId()}
			<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
		</Label>
		<Input
			id="srt-streamid"
			class="font-mono"
			disabled={isStreaming}
			oninput={(e) => onStreamId(e.currentTarget.value)}
			placeholder={$LL.settings.placeholders.srtStreamId()}
			value={streamId}
		/>
	</div>
{/if}

{#if showSecret}
	<div class="space-y-2">
		<Label class="text-sm font-medium" for="srtla-passphrase">
			{$LL.settings.relaySecret()}
			<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
		</Label>
		<Input
			id="srtla-passphrase"
			class="font-mono"
			disabled={isStreaming}
			oninput={(e) => onPassphrase(e.currentTarget.value)}
			placeholder={$LL.settings.relaySecretPlaceholder()}
			type="password"
			value={passphrase}
		/>
	</div>
{/if}

<!-- Validate the custom relay endpoint via relay.validate (Task 8/14). -->
<div class="space-y-3">
	<Button
		id="relay-validate"
		class="w-full"
		disabled={!canValidate}
		onclick={onValidate}
		variant="outline"
	>
		{#if validation.state === 'validating'}
			<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{$LL.settings.validating()}
		{:else}
			{$LL.settings.validate()}
		{/if}
	</Button>

	{#if validation.state !== 'idle'}
		<!-- Multi-stage result: each stage chip reflects its derived status. -->
		<ol class="flex flex-wrap gap-1.5" data-testid="validate-stages">
			{#each stageViews as { stage, status } (stage)}
				<li
					class="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium {status ===
					'failed'
						? 'border-destructive/40 text-destructive'
						: status === 'done'
							? 'border-primary/40 text-primary'
							: status === 'active'
								? 'text-foreground'
								: 'text-muted-foreground'}"
					data-stage={stage}
					data-status={status}
				>
					{#if status === 'active'}
						<Loader2 class="size-3 animate-spin motion-reduce:animate-none" />
					{:else if status === 'done'}
						<Check class="size-3" />
					{:else if status === 'failed'}
						<X class="size-3" />
					{:else}
						<Circle class="size-3 opacity-50" />
					{/if}
					{stageLabel(stage)}
				</li>
			{/each}
		</ol>

		{#if validation.state === 'pass'}
			<p class="text-primary text-sm" role="status">
				{$LL.settings.validationPassed()}
			</p>
		{:else if validation.state === 'fail'}
			<p class="text-destructive text-sm" role="alert">
				{$LL.settings.validationFailed()} ({validation.stage}){validation.reason
					? `: ${validation.reason}`
					: ''}
			</p>
		{/if}
	{/if}
</div>
