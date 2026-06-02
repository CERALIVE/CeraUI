<!--
  ServerDialog.svelte — SRTLA / relay-server configuration, surfaced from Live.

  Replaces the old shared/ServerCard.svelte, dropping its local-state mirror
  (six `local*` + five `*Touched` fields kept in sync via effects). Instead it
  reads the live server-pushed config (`getConfig`) and relay catalog
  (`getRelays`) directly and overlays only the fields the operator has actually
  edited (the `draft` dirty-field guard). Validation bounds come from the single
  source `streamingConstraints` (RPC schema consts), never inline literals.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Server } from '@lucide/svelte';
import type { StreamingConfigInput } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import { getConfig, getIsStreaming, getRelays } from '$lib/rpc/subscriptions.svelte';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';

interface Props {
	open?: boolean;
}
let { open = $bindable(false) }: Props = $props();

const PORT = streamingConstraints.port;
const LAT = streamingConstraints.srtLatency;
const LATENCY_FALLBACK = Math.min(Math.max(2000, LAT.min), LAT.max);
const LATENCY_STEP = 50;

const config = $derived(getConfig());
const relays = $derived(getRelays());
const isStreaming = $derived(Boolean(getIsStreaming()));

type Mode = 'manual' | 'relay';
type Draft = {
	mode?: Mode;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	srt_latency?: number;
	relay_server?: string;
	relay_account?: string;
};
let draft = $state<Draft>({});

$effect(() => {
	if (open) draft = {};
});

const mode = $derived<Mode>(draft.mode ?? (config?.relay_server ? 'relay' : 'manual'));

const addr = $derived(draft.srtla_addr ?? config?.srtla_addr ?? '');
const portStr = $derived(draft.srtla_port ?? (config?.srtla_port?.toString() ?? ''));
const streamId = $derived(draft.srt_streamid ?? config?.srt_streamid ?? '');
const latency = $derived(draft.srt_latency ?? config?.srt_latency ?? LATENCY_FALLBACK);
const relayServer = $derived(draft.relay_server ?? config?.relay_server ?? '');
const relayAccount = $derived(draft.relay_account ?? config?.relay_account ?? '');

const serverEntries = $derived(Object.entries(relays?.servers ?? {}));
const accountEntries = $derived(Object.entries(relays?.accounts ?? {}));
const relayServerName = $derived(relays?.servers?.[relayServer]?.name);
const relayAccountName = $derived(relays?.accounts?.[relayAccount]?.name);

const portNum = $derived(portStr.trim() === '' ? undefined : Number.parseInt(portStr, 10));
const portError = $derived.by(() => {
	if (mode !== 'manual' || portStr.trim() === '') return undefined;
	if (portNum === undefined || !Number.isInteger(portNum) || portNum < PORT.min || portNum > PORT.max) {
		return $LL.validation.portRange();
	}
	return undefined;
});
const addrError = $derived(
	mode === 'manual' && draft.srtla_addr !== undefined && draft.srtla_addr.trim() === ''
		? $LL.settings.errors.srtlaServerAddressRequired()
		: undefined,
);

const canSave = $derived.by(() => {
	if (isStreaming) return false;
	if (mode === 'manual') {
		return addr.trim() !== '' && portStr.trim() !== '' && portError === undefined;
	}
	return relayServer !== '';
});

const latencyPercent = $derived(
	Math.max(0, Math.min(100, ((latency - LAT.min) / (LAT.max - LAT.min)) * 100)),
);

function clampLatency(value: number): number {
	const safe = Number.isFinite(value) ? value : LATENCY_FALLBACK;
	const stepped = Math.round(safe / LATENCY_STEP) * LATENCY_STEP;
	return Math.max(LAT.min, Math.min(LAT.max, stepped));
}

async function handleSave() {
	const input: StreamingConfigInput = { srt_latency: clampLatency(latency) };
	if (mode === 'manual') {
		input.srtla_addr = addr.trim();
		input.srtla_port = portNum;
		input.srt_streamid = streamId.trim();
	} else {
		input.relay_server = relayServer;
		if (relayAccount) input.relay_account = relayAccount;
	}
	// Lock each field this save changes BEFORE the RPC so a stale server echo
	// of the old value can't revert the edit; release after it settles (resolve
	// or reject) to avoid a permanent lock.
	const fields = Object.entries(input).filter(([, value]) => value !== undefined);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await rpc.streaming.setConfig(input);
		toast.success($LL.notifications.saved());
		open = false;
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}
</script>

<AppDialog
	bind:open
	icon={Server}
	onPrimary={handleSave}
	primaryDisabled={!canSave}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.settings.receiverServer()}
>
	<div class="space-y-5">
		{#if isStreaming}
			<p
				class="rounded-lg border px-3 py-2 text-sm"
				style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 35%, transparent); background-color: color-mix(in oklab, var(--status-live) 10%, transparent);"
			>
				{$LL.live.stopToChange()}
			</p>
		{/if}

		<!-- Mode toggle: manual SRTLA target vs a managed relay server -->
		<div class="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1" role="tablist">
			<button
				aria-selected={mode === 'manual'}
				class="rounded-md px-3 py-2 text-sm font-medium transition-colors {mode === 'manual'
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'}"
				disabled={isStreaming}
				onclick={() => (draft.mode = 'manual')}
				role="tab"
				type="button"
			>
				{$LL.settings.manualConfiguration()}
			</button>
			<button
				aria-selected={mode === 'relay'}
				class="rounded-md px-3 py-2 text-sm font-medium transition-colors {mode === 'relay'
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'}"
				disabled={isStreaming}
				onclick={() => (draft.mode = 'relay')}
				role="tab"
				type="button"
			>
				{$LL.settings.relayServer()}
			</button>
		</div>

		{#if mode === 'manual'}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtla-addr">
					{$LL.settings.srtlaServerAddress()}
				</Label>
				<Input
					id="srtla-addr"
					aria-invalid={addrError ? 'true' : undefined}
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => (draft.srtla_addr = e.currentTarget.value)}
					placeholder={$LL.settings.placeholders.srtlaServerAddress()}
					value={addr}
				/>
				{#if addrError}
					<p class="text-destructive text-sm">{addrError}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtla-port">
					{$LL.settings.srtlaServerPort()}
				</Label>
				<Input
					id="srtla-port"
					aria-invalid={portError ? 'true' : undefined}
					class="font-mono"
					disabled={isStreaming}
					inputmode="numeric"
					max={PORT.max}
					min={PORT.min}
					oninput={(e) => (draft.srtla_port = e.currentTarget.value)}
					placeholder={$LL.settings.placeholders.srtlaServerPort()}
					type="number"
					value={portStr}
				/>
				{#if portError}
					<p class="text-destructive text-sm">{portError}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srt-streamid">
					{$LL.settings.srtStreamId()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Input
					id="srt-streamid"
					class="font-mono"
					disabled={isStreaming}
					oninput={(e) => (draft.srt_streamid = e.currentTarget.value)}
					placeholder={$LL.settings.placeholders.srtStreamId()}
					value={streamId}
				/>
			</div>
		{:else}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-server">{$LL.settings.relayServer()}</Label>
				<Select.Root
					disabled={relays === undefined || isStreaming}
					onValueChange={(value) => (draft.relay_server = value)}
					type="single"
					value={relayServer}
				>
					<Select.Trigger id="relay-server" class="w-full">
						{relayServerName ?? $LL.settings.relayServer()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each serverEntries as [id, info] (id)}
								<Select.Item value={id}>
									<div class="flex items-center gap-2">
										<div aria-hidden={true} class="bg-primary h-2 w-2 rounded-full"></div>
										{info.name}
									</div>
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relay-account">
					{$LL.settings.relayServerAccount()}
					<span class="text-muted-foreground ms-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Select.Root
					disabled={relays === undefined || isStreaming}
					onValueChange={(value) => (draft.relay_account = value)}
					type="single"
					value={relayAccount}
				>
					<Select.Trigger id="relay-account" class="w-full">
						{relayAccountName ?? $LL.settings.manualConfiguration()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each accountEntries as [id, info] (id)}
								<Select.Item value={id}>
									<div class="flex items-center gap-2">
										<div aria-hidden={true} class="bg-primary h-2 w-2 rounded-full"></div>
										{info.name}
									</div>
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}

		<!-- SRT latency: bounds come from streamingConstraints.srtLatency -->
		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<Label class="text-sm font-medium" for="srt-latency">{$LL.settings.srtLatency()}</Label>
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
					{latency} {$LL.units.ms()}
				</span>
			</div>
			<div class="relative h-6 w-full">
				<div
					class="bg-background absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
				></div>
				<div
					style={`inset-inline-start: 0; width: ${latencyPercent}%;`}
					class="bg-primary absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-150"
				></div>
				<input
					id="srt-latency"
					aria-valuemax={LAT.max}
					aria-valuemin={LAT.min}
					aria-valuenow={latency}
					class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					disabled={isStreaming}
					max={LAT.max}
					min={LAT.min}
					oninput={(e) => (draft.srt_latency = Number.parseInt(e.currentTarget.value, 10))}
					step={LATENCY_STEP}
					type="range"
					value={latency}
				/>
			</div>
			<div class="text-muted-foreground flex justify-between text-xs">
				<span>{LAT.min} {$LL.units.ms()} · {$LL.settings.lowerLatency()}</span>
				<span>{$LL.settings.higherLatency()} · {LAT.max} {$LL.units.ms()}</span>
			</div>
		</div>
	</div>
</AppDialog>
