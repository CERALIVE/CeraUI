<!--
  TransportBadge.svelte — calm, derived "how the stream reaches the receiver"
  SUMMARY chip. Read-only: it makes no protocol choice (T21 promoted the
  transport-protocol picker to the always-visible ProtocolSelector above the
  endpoint section). The badge only reflects the current selection.

  The badge is purely DERIVED from the current protocol + destination (managed
  relay vs. custom) via @ceraui/rpc's `deriveReceiverKind`; the shared T5 helper
  `kindBadgeLabelKey` (lib/streaming/receiver-experience) maps that kind onto the
  calm `live.server.kind.*` copy, resolved through the `$LL` proxy here. SRTLA is
  the sole wired bonded path, so only it adds a "bonded across N / single link"
  readiness line — RIST and SRT make no unverified bonding claim.

  Engine-offline honesty: when `getCapabilities()` is undefined the engine has not
  advertised its transports, so the badge drops to a NEUTRAL state (the bare
  transport acronym, no bonded/single claim — never a stale "SRTLA · Bonded").

  Motion is CSS-only (Tailwind transition-/animate- utilities; no Svelte motion
  directives). The pulse uses the `motion-safe` variant, and the e-ink freeze
  (`app.css [data-display='eink']`) + `prefers-reduced-motion` still every
  animation globally.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { deriveReceiverKind, type RelayProtocol } from '@ceraui/rpc/schemas';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { getCapabilities } from '$lib/rpc/subscriptions.svelte';
import { kindBadgeLabelKey } from '$lib/streaming/receiver-experience';
import { cn } from '$lib/utils';

interface Props {
	/** Current transport protocol (canonical single-transport field). */
	protocol: RelayProtocol;
	/** Whether a managed relay server is configured (relay vs. custom destination). */
	hasRelayServer: boolean;
	/**
	 * Live active link count, when known. SRTLA bonds across links: a single
	 * active link reads "single link", otherwise "bonded". Undefined keeps the
	 * canonical "bonded" label (SRTLA's defining behaviour).
	 */
	bondedLinkCount?: number;
}

let { protocol, hasRelayServer, bondedLinkCount }: Props = $props();

// Protocol acronyms are technical identifiers, not translated copy (mirrors the
// literal provider brand names in ServerDialog).
const PROTOCOL_LABELS: Record<RelayProtocol, string> = {
	srtla: 'SRTLA',
	srt: 'SRT',
	rist: 'RIST',
};

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
</script>

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
