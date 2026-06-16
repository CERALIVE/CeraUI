<!--
  ServerDialog.svelte — SRTLA / relay-server configuration, surfaced from Live.

  Method-based UI (Task 16), split into focused sub-components (Task 14):
   • Two transport methods stay as the existing tab toggle — Manual Configuration
     (`ManualEndpointForm`: a custom relay address/port/streamid/secret with a
     "Validate" action) and Relay Server (`RelayServerSelector`: a managed-provider
     catalog with provider grouping, an auto-preloaded READ-ONLY endpoint + manual
     override, account selector, and an editable Stream ID).
   • Manual mode validates the endpoint through `relay.validate` (Task 8 adapter)
     and surfaces the multi-stage result inline; Save is blocked while a validation
     is in flight or failing (the `relay-validation` reducer owns that gate).

  This dialog stays the logic container: it owns the `draft` dirty-field guard,
  every derived value, and the validate + save handlers; the sub-components are
  presentational. Live config (`getConfig`) and the relay catalog (`getRelays`)
  are read directly and overlaid only with the operator's edits. Validation bounds
  and port parsing come from `ValidationAdapter` (RPC schema consts).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Server } from '@lucide/svelte';
import {
	RELAY_PROTOCOLS,
	type RelayProtocol,
	type RelayProtocolUnavailableReason,
	relayProtocolAvailability,
	type StreamingConfigInput,
} from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Label } from '$lib/components/ui/label';
import {
	isPortValid,
	parsePort,
	streamingConstraints,
} from '$lib/components/streaming/ValidationAdapter';
import {
	type Validation,
	manualSaveEnabled,
	reduceValidateError,
	reduceValidateResult,
} from '$lib/components/streaming/relay-validation';
import { getCapabilities, getConfig, getIsStreaming, getRelays } from '$lib/rpc/subscriptions.svelte';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import ManualEndpointForm from './server/ManualEndpointForm.svelte';
import RelayServerSelector from './server/RelayServerSelector.svelte';

interface Props {
	open?: boolean;
}
let { open = $bindable(false) }: Props = $props();

const PORT = streamingConstraints.port;
const LAT = streamingConstraints.srtLatency;
const LATENCY_FALLBACK = Math.min(Math.max(2000, LAT.min), LAT.max);
const LATENCY_STEP = 50;

// Managed cloud providers the relay catalog can be grouped under. Brand names
// are not translated (per the i18n branding convention), so they stay literal.
const MANAGED_PROVIDERS = ['ceralive', 'belabox'] as const;
const PROVIDER_LABELS: Record<string, string> = {
	ceralive: 'CeraLive Cloud',
	belabox: 'BELABOX Cloud',
};

const config = $derived(getConfig());
const relays = $derived(getRelays());
const isStreaming = $derived(Boolean(getIsStreaming()));

// Transport protocol selection. Protocol acronyms are technical identifiers, not
// translated copy (mirrors the literal provider brand names below).
const PROTOCOL_LABELS: Record<RelayProtocol, string> = {
	srtla: 'SRTLA',
	srt: 'SRT',
	rist: 'RIST',
};

function protocolReason(reason: RelayProtocolUnavailableReason | undefined): string | undefined {
	if (reason === 'capability') return $LL.settings.protocolRistUnavailable();
	if (reason === 'reserved') return $LL.settings.protocolReserved();
	return undefined;
}

type Mode = 'manual' | 'relay';
type Draft = {
	mode?: Mode;
	relay_protocol?: RelayProtocol;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	srt_latency?: number;
	relay_provider?: string;
	relay_server?: string;
	relay_account?: string;
	relay_streamid?: string;
	relay_override?: boolean;
	relay_override_addr?: string;
	relay_override_port?: string;
	passphrase?: string;
};
let draft = $state<Draft>({});

let validation = $state<Validation>({ state: 'idle' });

$effect(() => {
	if (open) {
		draft = {};
		validation = { state: 'idle' };
	}
});

const mode = $derived<Mode>(draft.mode ?? (config?.relay_server ? 'relay' : 'manual'));

// RIST is capability-gated: the option stays visible but disabled (with a
// reason) until the engine advertises the `rist` transport; SRT is reserved.
const transports = $derived(getCapabilities()?.transports);
const protocol = $derived<RelayProtocol>(
	draft.relay_protocol ?? config?.relay_protocol ?? 'srtla',
);
const protocolOptions = $derived(
	RELAY_PROTOCOLS.map((value) => ({
		value,
		label: PROTOCOL_LABELS[value],
		...relayProtocolAvailability(value, transports),
	})),
);
const protocolSelectable = $derived(
	relayProtocolAvailability(protocol, transports).selectable,
);

const addr = $derived(draft.srtla_addr ?? config?.srtla_addr ?? '');
const portStr = $derived(draft.srtla_port ?? (config?.srtla_port?.toString() ?? ''));
const streamId = $derived(draft.srt_streamid ?? config?.srt_streamid ?? '');
const passphrase = $derived(draft.passphrase ?? '');
const latency = $derived(draft.srt_latency ?? config?.srt_latency ?? LATENCY_FALLBACK);
const relayServer = $derived(draft.relay_server ?? config?.relay_server ?? '');
const relayAccount = $derived(draft.relay_account ?? config?.relay_account ?? '');
const relayStreamId = $derived(draft.relay_streamid ?? config?.relay_streamid_override ?? '');

const serverEntries = $derived(Object.entries(relays?.servers ?? {}));
const accountEntries = $derived(Object.entries(relays?.accounts ?? {}));

// Relay availability gate (D6): the relay tab is always rendered but stays
// disabled with an i18n hint until the catalog exists. `getRelays()` is
// `undefined` until the cloud provider's relays cache is populated (never in
// mock/dev), and may arrive empty — surface the matching waiting / none copy.
const relayUnavailable = $derived(relays === undefined || serverEntries.length === 0);
const relayHint = $derived(
	relays === undefined ? $LL.notifications.relayWaiting() : $LL.notifications.relayNone(),
);

// Provider grouping: untagged catalog servers belong to the device's configured
// provider, so the selector defaults to it and lists only that provider's relays.
const configProvider = $derived(
	config?.remote_provider && config.remote_provider !== 'custom'
		? config.remote_provider
		: 'ceralive',
);
const selectedProvider = $derived(draft.relay_provider ?? configProvider);
const filteredServerEntries = $derived(
	serverEntries.filter(([, info]) => (info.provider?.kind ?? configProvider) === selectedProvider),
);

const relayServerInfo = $derived(relays?.servers?.[relayServer]);
const relayServerName = $derived(relayServerInfo?.name);
const relayServerRtt = $derived(relayServerInfo?.rtt);
const relayServerEndpoint = $derived(
	relayServerInfo?.addr && relayServerInfo?.port
		? `${relayServerInfo.addr}:${relayServerInfo.port}`
		: undefined,
);
const relayAccountName = $derived(relays?.accounts?.[relayAccount]?.name);

const relayOverride = $derived(draft.relay_override ?? false);
const overrideAddr = $derived(draft.relay_override_addr ?? relayServerInfo?.addr ?? '');
const overridePortStr = $derived(
	draft.relay_override_port ?? (relayServerInfo?.port?.toString() ?? ''),
);

const portNum = $derived(parsePort(portStr));
const portError = $derived.by(() => {
	if (mode !== 'manual' || portStr.trim() === '') return undefined;
	if (!isPortValid(portNum)) return $LL.validation.portRange();
	return undefined;
});
const overridePortNum = $derived(parsePort(overridePortStr));
const overridePortError = $derived.by(() => {
	if (!relayOverride || overridePortStr.trim() === '') return undefined;
	if (!isPortValid(overridePortNum)) return $LL.validation.portRange();
	return undefined;
});
const addrError = $derived(
	mode === 'manual' && draft.srtla_addr !== undefined && draft.srtla_addr.trim() === ''
		? $LL.settings.errors.srtlaServerAddressRequired()
		: undefined,
);

const canValidate = $derived(
	!isStreaming &&
		addr.trim() !== '' &&
		portStr.trim() !== '' &&
		portError === undefined &&
		validation.state !== 'validating',
);

const canSave = $derived.by(() => {
	// A capability-gated or reserved protocol can never be saved (RIST without
	// the engine capability, or the reserved SRT placeholder).
	if (!protocolSelectable) return false;
	if (mode === 'manual') {
		return manualSaveEnabled({
			isStreaming,
			addr,
			portStr,
			hasPortError: portError !== undefined,
			validation,
		});
	}
	if (isStreaming) return false;
	if (relayOverride) {
		return (
			overrideAddr.trim() !== '' &&
			overridePortStr.trim() !== '' &&
			overridePortError === undefined
		);
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

function resetValidation() {
	if (validation.state !== 'idle') validation = { state: 'idle' };
}

async function handleValidate() {
	validation = { state: 'validating' };
	try {
		const result = await rpc.relay.validate({
			addr: addr.trim(),
			port: portNum ?? 0,
			streamid: streamId.trim() === '' ? undefined : streamId.trim(),
			passphrase: passphrase.trim() === '' ? undefined : passphrase.trim(),
			protocol: 'srtla',
		});
		validation = reduceValidateResult(result);
	} catch (error) {
		validation = reduceValidateError(error);
	}
}

async function handleSave() {
	const input: StreamingConfigInput = {
		srt_latency: clampLatency(latency),
		relay_protocol: protocol,
	};
	if (mode === 'manual') {
		input.srtla_addr = addr.trim();
		input.srtla_port = portNum;
		input.srt_streamid = streamId.trim();
	} else if (relayOverride) {
		input.srtla_addr = overrideAddr.trim();
		input.srtla_port = overridePortNum;
		input.relay_streamid_override = relayStreamId.trim();
	} else {
		input.relay_server = relayServer;
		if (relayAccount) input.relay_account = relayAccount;
		input.relay_streamid_override = relayStreamId.trim();
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

		<!-- Transport protocol: SRTLA always available; RIST gated on the engine
		     capability; SRT reserved. Unavailable options stay visible but disabled
		     with a reason (never hidden), per the capability-consumer pattern. -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="transport-protocol">
				{$LL.settings.transportProtocol()}
			</Label>
			<div
				id="transport-protocol"
				class="grid grid-cols-3 gap-1"
				data-testid="transport-protocol"
				role="radiogroup"
			>
				{#each protocolOptions as option (option.value)}
					{@const reason = protocolReason(option.reason)}
					<button
						aria-checked={protocol === option.value}
						class="flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors {protocol ===
						option.value
							? 'border-primary bg-primary/10 text-foreground'
							: 'border-border text-muted-foreground hover:text-foreground'} disabled:cursor-not-allowed disabled:opacity-50"
						data-protocol={option.value}
						data-testid={`protocol-${option.value}`}
						disabled={isStreaming || !option.selectable}
						onclick={() => (draft.relay_protocol = option.value)}
						role="radio"
						title={reason}
						type="button"
					>
						<span class="font-mono">{option.label}</span>
						{#if reason}
							<span class="text-muted-foreground text-[0.65rem] leading-tight">{reason}</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>

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
				disabled={relays === undefined || isStreaming}
				onclick={() => (draft.mode = 'relay')}
				role="tab"
				type="button"
			>
				{$LL.settings.relayServer()}
			</button>
		</div>

		<!-- Relay gate hint (D6): explains the disabled relay tab while the relay
		     catalog is missing (waiting) or empty (none). Manual stays usable. -->
		{#if relayUnavailable}
			<p
				class="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-sm"
				role="status"
			>
				{relayHint}
			</p>
		{/if}

		{#if mode === 'manual'}
			<ManualEndpointForm
				{addr}
				{addrError}
				{canValidate}
				{isStreaming}
				onAddr={(value) => {
					draft.srtla_addr = value;
					resetValidation();
				}}
				onPassphrase={(value) => {
					draft.passphrase = value;
					resetValidation();
				}}
				onPort={(value) => {
					draft.srtla_port = value;
					resetValidation();
				}}
				onStreamId={(value) => {
					draft.srt_streamid = value;
					resetValidation();
				}}
				onValidate={handleValidate}
				{passphrase}
				port={PORT}
				{portError}
				{portStr}
				{streamId}
				{validation}
			/>
		{:else}
			<RelayServerSelector
				{accountEntries}
				{filteredServerEntries}
				{isStreaming}
				managedProviders={MANAGED_PROVIDERS}
				onAccount={(value) => (draft.relay_account = value)}
				onOverrideAddr={(value) => (draft.relay_override_addr = value)}
				onOverridePort={(value) => (draft.relay_override_port = value)}
				onProvider={(value) => (draft.relay_provider = value)}
				onRelayStreamId={(value) => (draft.relay_streamid = value)}
				onServer={(value) => (draft.relay_server = value)}
				onToggleOverride={() => (draft.relay_override = !relayOverride)}
				{overrideAddr}
				{overridePortError}
				{overridePortStr}
				port={PORT}
				providerLabels={PROVIDER_LABELS}
				{relayAccount}
				{relayAccountName}
				{relayOverride}
				{relayServer}
				{relayServerEndpoint}
				{relayServerName}
				{relayServerRtt}
				relaysUnavailable={relays === undefined}
				{relayStreamId}
				{selectedProvider}
			/>
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
