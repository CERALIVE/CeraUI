<!--
  ProtocolSelector.svelte — the always-visible transport-protocol radiogroup.

  Promoted (T21) to a primary control ABOVE the endpoint section: choosing HOW
  the stream reaches the receiver (SRTLA / RIST / plain-SRT) is part of the core
  decision, no longer demoted behind an "Advanced" disclosure. The derived "how
  it reaches the receiver" summary stays in the calm read-only TransportBadge
  chip; this component owns only the picker.

  SRTLA is always selectable; RIST is capability-gated (disabled-with-reason
  until the engine advertises the `rist` transport — never hidden); plain-SRT is
  a calm, INERT ComingSoon affordance bound to the open tech-debt entry, never a
  fake-interactive radio. Reads `getCapabilities()` itself so the container does
  not thread capability state.

  Motion is CSS-only and e-ink / reduced-motion safe (no Svelte motion
  directives here).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	type RelayProtocol,
	type RelayProtocolUnavailableReason,
	relayProtocolAvailability,
} from '@ceraui/rpc/schemas';
import { tick } from 'svelte';

import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import { getCapabilities } from '$lib/rpc/subscriptions.svelte';

interface Props {
	/** Current transport protocol (canonical single-transport field). */
	protocol: RelayProtocol;
	/** Stream is live — protocol selection is frozen while streaming. */
	isStreaming?: boolean;
	/** Apply a protocol change picked from the radiogroup. */
	onProtocol: (value: RelayProtocol) => void;
}

let { protocol, isStreaming = false, onProtocol }: Props = $props();

// Protocol acronyms are technical identifiers, not translated copy (mirrors the
// literal provider brand names in ServerDialog).
const PROTOCOL_LABELS: Record<RelayProtocol, string> = {
	srtla: 'SRTLA',
	srt: 'SRT',
	rist: 'RIST',
};

// The radiogroup offers only the two protocols that can ever resolve to a radio:
// SRTLA (always) and RIST (capability-gated). Plain-SRT is a ComingSoon cell.
const RADIO_PROTOCOLS = ['srtla', 'rist'] as const;
type RadioProtocol = (typeof RADIO_PROTOCOLS)[number];

function protocolReason(reason: RelayProtocolUnavailableReason | undefined): string | undefined {
	if (reason === 'capability') return $LL.settings.protocolRistUnavailable();
	if (reason === 'reserved') return $LL.settings.protocolReserved();
	return undefined;
}

const transports = $derived(getCapabilities()?.transports);

const radioOptions = $derived(
	RADIO_PROTOCOLS.map((value) => ({
		value,
		label: PROTOCOL_LABELS[value],
		...relayProtocolAvailability(value, transports),
	})),
);
const enabledValues = $derived(
	radioOptions.filter((option) => option.selectable && !isStreaming).map((option) => option.value),
);
// Roving tabindex anchor: the checked radio, else the first selectable one (the
// configured protocol may be the reserved SRT, which has no radio).
const rovingValue = $derived<RadioProtocol>(
	RADIO_PROTOCOLS.find((value) => value === protocol) ?? enabledValues[0] ?? 'srtla',
);

let radioEls = $state<Array<HTMLButtonElement | undefined>>([]);

async function focusValue(value: RelayProtocol) {
	const idx = radioOptions.findIndex((option) => option.value === value);
	if (idx === -1) return;
	await tick();
	radioEls[idx]?.focus();
}

function onRadioKeydown(event: KeyboardEvent) {
	const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
	const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
	if (!forward && !back) return;
	if (enabledValues.length === 0) return;
	event.preventDefault();
	const current = enabledValues.indexOf(rovingValue);
	const base = current === -1 ? 0 : current;
	const delta = forward ? 1 : -1;
	const next = enabledValues[(base + delta + enabledValues.length) % enabledValues.length];
	if (next === undefined) return;
	// Radio selection follows focus (standard radiogroup pattern).
	onProtocol(next);
	void focusValue(next);
}
</script>

<div class="space-y-2">
	<span id="protocol-selector-label" class="text-sm font-medium">
		{$LL.settings.transportProtocol()}
	</span>

	<div
		aria-labelledby="protocol-selector-label"
		class="grid grid-cols-3 gap-1"
		data-testid="transport-protocol"
		id="transport-protocol"
		onkeydown={onRadioKeydown}
		role="radiogroup"
		tabindex={-1}
	>
		{#each radioOptions as option, i (option.value)}
			{@const reason = protocolReason(option.reason)}
			<button
				aria-checked={protocol === option.value}
				bind:this={radioEls[i]}
				class="border-border text-muted-foreground hover:text-foreground flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {protocol ===
				option.value
					? 'border-primary bg-primary/10 text-foreground'
					: ''}"
				data-protocol={option.value}
				data-testid={`protocol-${option.value}`}
				disabled={isStreaming || !option.selectable}
				onclick={() => onProtocol(option.value)}
				role="radio"
				tabindex={option.value === rovingValue ? 0 : -1}
				title={reason}
				type="button"
			>
				<span class="font-mono">{option.label}</span>
				{#if reason}
					<span class="text-muted-foreground text-[0.65rem] leading-tight">{reason}</span>
				{/if}
			</button>
		{/each}

		<!--
			Plain-SRT (non-SRTLA) egress is a genuine future capability surfaced
			as a calm, INERT ComingSoon affordance — never a fake-interactive
			radio. The static binding the CI gate (scripts/check-tech-debt.mjs)
			verifies is the literal id below; the ComingSoon renders the dynamic
			data-debt-id into the DOM for tests (mirrors LiveView.svelte:600-626).
			Visually recessed (no tile border, dimmed) so it reads as a reserved
			slot, not a peer of the two real radios.
			roadmap: data-debt-id="TD-plain-srt-egress"
		-->
		<div
			class="text-muted-foreground/70 flex flex-col items-center gap-0.5 px-3 py-2 text-sm font-medium opacity-80"
			data-protocol="srt"
			data-testid="protocol-srt"
		>
			<span class="font-mono">{PROTOCOL_LABELS.srt}</span>
			<ComingSoon debtId="TD-plain-srt-egress" />
		</div>
	</div>
</div>
