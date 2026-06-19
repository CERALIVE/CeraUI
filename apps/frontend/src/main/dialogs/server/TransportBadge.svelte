<!--
  TransportBadge.svelte — calm, derived "how the stream reaches the receiver"
  badge plus an Advanced disclosure that mounts the transport-protocol radiogroup.

  The badge is purely DERIVED from the current protocol + destination (managed
  relay vs. custom) via @ceraui/rpc's `deriveReceiverKind`; the shared T5 helper
  `kindBadgeLabelKey` (lib/streaming/receiver-experience) maps that kind onto the
  calm `live.server.kind.*` copy, resolved through the `$LL` proxy here. SRTLA is
  the sole wired bonded path, so only it adds a "bonded across N / single link"
  readiness line — RIST and SRT make no unverified bonding claim.

  Engine-offline honesty: when `getCapabilities()` is undefined the engine has not
  advertised its transports, so the badge drops to a NEUTRAL state (the bare
  transport acronym, no bonded/single claim — never a stale "SRTLA · Bonded") and
  RIST is disabled-with-reason (capability), never hidden.

  The Advanced disclosure mounts the radiogroup ONLY when expanded ({#if expanded},
  not a CSS-hidden node) so collapsed state ships zero radio DOM. SRTLA is always
  selectable; RIST is capability-gated (disabled-with-reason); plain-SRT is a calm,
  inert ComingSoon affordance bound to the open tech-debt entry — never a
  fake-interactive control.

  Motion is CSS-only (Tailwind transition-/animate- utilities; no Svelte motion
  directives). The pulse uses the `motion-safe` variant, and the e-ink freeze
  (`app.css [data-display='eink']`) + `prefers-reduced-motion` still every
  animation globally.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronDown } from '@lucide/svelte';
import {
	deriveReceiverKind,
	type RelayProtocol,
	type RelayProtocolUnavailableReason,
	relayProtocolAvailability,
} from '@ceraui/rpc/schemas';
import { tick } from 'svelte';

import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { getCapabilities } from '$lib/rpc/subscriptions.svelte';
import { kindBadgeLabelKey } from '$lib/streaming/receiver-experience';
import { cn } from '$lib/utils';

interface Props {
	/** Current transport protocol (canonical single-transport field). */
	protocol: RelayProtocol;
	/** Whether a managed relay server is configured (relay vs. custom destination). */
	hasRelayServer: boolean;
	/** Stream is live — protocol selection is frozen while streaming. */
	isStreaming?: boolean;
	/**
	 * Live active link count, when known. SRTLA bonds across links: a single
	 * active link reads "single link", otherwise "bonded". Undefined keeps the
	 * canonical "bonded" label (SRTLA's defining behaviour).
	 */
	bondedLinkCount?: number;
	/** Apply a protocol change picked from the Advanced radiogroup. */
	onProtocol: (value: RelayProtocol) => void;
}

let { protocol, hasRelayServer, isStreaming = false, bondedLinkCount, onProtocol }: Props =
	$props();

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

// Resolve a dot-path i18n key through the typed `$LL` proxy, falling back to the
// raw key on a miss (mirrors the EncoderDialog / AudioDialog / LiveView helper).
// `kindBadgeLabelKey` returns a `live.server.kind.*` key, so the badge copy stays
// the single source of truth in the i18n layer, not duplicated here.
const t = (key: string): string => {
	let result: unknown = $LL;
	for (const part of key.split('.')) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// Engine-offline = no advertised capability snapshot. Read directly so the badge
// is honest standalone: a neutral state, never a stale bonded claim.
const engineOnline = $derived(getCapabilities() !== undefined);
const transports = $derived(getCapabilities()?.transports);

const kind = $derived(deriveReceiverKind({ protocol, hasRelayServer }));
const isSrtla = $derived(kind === 'srtla_relay' || kind === 'srtla_custom');

// While the engine is offline the configured transport is known but its bonding
// status is not — show the bare acronym, never a stale "SRTLA · Bonded".
const badgeLabel = $derived(engineOnline ? t(kindBadgeLabelKey(kind)) : PROTOCOL_LABELS[protocol]);

// Bonded/single-link readiness is asserted ONLY for SRTLA (the sole wired bonded
// path) and only when the live link count is known — non-SRTLA makes no bonding
// claim. A single active link reads "single link"; otherwise "bonded across N".
const readiness = $derived.by(() => {
	if (!engineOnline || !isSrtla || bondedLinkCount === undefined) return undefined;
	return bondedLinkCount <= 1
		? $LL.live.server.singleLink()
		: $LL.live.server.bondedAcross({ count: bondedLinkCount });
});

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

let expanded = $state(false);
let triggerEl = $state<HTMLButtonElement>();
let radioEls = $state<Array<HTMLButtonElement | undefined>>([]);

async function toggle() {
	expanded = !expanded;
	await tick();
	// Focus moves into the freshly-mounted group (first radio) on open, and back
	// to the trigger on close, so keyboard focus is never stranded.
	if (expanded) radioEls[0]?.focus();
	else triggerEl?.focus();
}

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
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1">
			<span class="text-sm font-medium">{$LL.settings.transportKind()}</span>
			<InfoPopover
				body={$LL.settings.transportKindHint()}
				testId="transport-badge-info"
				title={$LL.settings.transportKind()}
			/>
		</div>

		<div class="flex flex-col items-end gap-0.5">
			<span
				class={cn(
					'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
					engineOnline
						? 'border-primary/30 bg-primary/10 text-foreground'
						: 'border-border bg-muted text-muted-foreground',
				)}
				data-engine-online={engineOnline}
				data-testid="transport-badge"
			>
				<span
					class={cn(
						'size-1.5 shrink-0 rounded-full',
						engineOnline ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground/50',
					)}
					aria-hidden={true}
				></span>
				{badgeLabel}
			</span>
			{#if readiness}
				<span class="text-muted-foreground text-[0.65rem] leading-tight" data-testid="transport-readiness">
					{readiness}
				</span>
			{/if}
		</div>
	</div>

	<div>
		<button
			aria-controls="transport-protocol"
			aria-expanded={expanded}
			bind:this={triggerEl}
			class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm font-medium transition-colors"
			onclick={toggle}
			type="button"
		>
			{$LL.settings.transportAdvanced()}
			<ChevronDown
				aria-hidden={true}
				class={cn('size-4 transition-transform', expanded && 'rotate-180')}
			/>
		</button>

		{#if expanded}
			<div
				class="mt-2 space-y-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
			>
				<div
					aria-label={$LL.settings.transportProtocol()}
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
						roadmap: data-debt-id="TD-plain-srt-egress"
					-->
					<div
						class="border-border text-muted-foreground flex flex-col items-center gap-0.5 rounded-md border border-dashed px-3 py-2 text-sm font-medium"
						data-protocol="srt"
						data-testid="protocol-srt"
					>
						<span class="font-mono">{PROTOCOL_LABELS.srt}</span>
						<ComingSoon debtId="TD-plain-srt-egress" />
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
