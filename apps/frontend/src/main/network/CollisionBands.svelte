<!--
  CollisionBands.svelte — subnet-collision + policy-route health surfacing (Task 13).

  Purely informational/warning UI derived from two additive-optional netif fields
  (Todo 11 + Todo 12) — NEVER a functional gate: this component disables no
  interface and blocks no stream. It renders at most two calm bands:

    • same_subnet_group set on any interface  → a CALM, INFORMATIONAL band
      (neutral/info styling, NEVER amber/red). Different IPs on the same subnet
      are handled by the OS per-link policy routing, so this is expected, not an
      error.
    • policy_route_missing === true on any    → an amber WARNING band: a bonded
      link may route through the wrong modem. The dispatcher reinstalls the rules
      when the link comes back up, so the guidance is reboot / re-plug.

    • bond_mapping disposition other than `mapped` → an amber WARNING band naming
      what is and is not bonded, plus the sender's typed reason. It is DRIVEN by
      the one normalized disposition stream and never inferred: a duplicate-IP
      pair is bonded when a per-interface mapping is in force, so "these links
      can't be used" is no longer a truthful thing to say about them.

  The existing duplicate-IPv4 path is a backend `netif_dup_ip` NOTIFICATION and is
  entirely separate from this component — it is neither read nor rendered here.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { BondMapping, NetifMessage } from '@ceraui/rpc/schemas';
import { Info, TriangleAlert } from '@lucide/svelte';

import { bondMappingBand } from './bond-mapping-band';

interface Props {
	/** Live netif snapshot from `getNetif()`; `undefined` before the first push. */
	netif: NetifMessage | undefined;
	/**
	 * The ONE normalized bind-map disposition. Explicitly `null` when no bond is
	 * described, so a band raised mid-stream is actually retracted.
	 */
	bondMapping?: BondMapping | null;
}

const { netif, bondMapping = null }: Props = $props();

const mappingBand = $derived(bondMappingBand(bondMapping));

const entries = $derived(Object.values(netif ?? {}));

// Distinct shared-subnet CIDRs. Every member of a group carries the IDENTICAL
// CIDR string (deterministic from ip & netmask on the backend), so a Set both
// de-duplicates and gives us the label(s) to show. Truthiness check — the field
// is a CIDR string, never a boolean.
const sameSubnetGroups = $derived([
	...new Set(
		entries
			.map((entry) => entry.same_subnet_group)
			.filter((group): group is string => Boolean(group)),
	),
]);

// Tristate: `true` flags a real gap, `false` is an all-clear that must retract a
// previously-raised band, and absent means the backend had no verdict this tick.
const hasPolicyRouteMissing = $derived(entries.some((entry) => entry.policy_route_missing === true));
</script>

{#if sameSubnetGroups.length > 0}
	<!-- CALM / INFORMATIONAL — neutral info styling, never a warning colour. -->
	<div
		data-testid="same-subnet-info"
		role="status"
		class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-xl border p-4"
	>
		<Info class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-semibold tracking-tight">
				{m["network.collision.sameSubnetTitle"]()}
			</p>
			<p class="text-muted-foreground text-sm">
				{m["network.collision.sameSubnetBody"]()}
			</p>
			<div class="flex flex-wrap gap-1.5 pt-0.5">
				{#each sameSubnetGroups as group (group)}
					<code
						class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 font-mono text-xs"
						>{group}</code
					>
				{/each}
			</div>
		</div>
	</div>
{/if}

{#if hasPolicyRouteMissing}
	<!-- WARNING — amber; a bonded link may route through the wrong modem. -->
	<div
		data-testid="policy-route-warning"
		role="status"
		class="bg-status-warning/10 border-status-warning/30 flex items-start gap-3 rounded-xl border p-4"
	>
		<TriangleAlert class="text-status-warning mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-semibold tracking-tight">
				{m["network.collision.policyRouteTitle"]()}
			</p>
			<p class="text-muted-foreground text-sm">
				{m["network.collision.policyRouteBody"]()}
			</p>
		</div>
	</div>
{/if}

{#if mappingBand}
	<!-- WARNING — amber; the bond is running, but not the way it was described. -->
	<div
		data-testid="bond-mapping-warning"
		data-disposition={bondMapping?.disposition}
		role="status"
		class="bg-status-warning/10 border-status-warning/30 flex items-start gap-3 rounded-xl border p-4"
	>
		<TriangleAlert class="text-status-warning mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-semibold tracking-tight" data-testid="bond-mapping-title">
				{resolveMessageKey(mappingBand.titleKey)}
			</p>
			<p class="text-muted-foreground text-sm">
				{resolveMessageKey(mappingBand.bodyKey)}
			</p>
			{#if mappingBand.reasonKey}
				<p class="text-muted-foreground text-sm" data-testid="bond-mapping-reason">
					<span class="font-medium">{m["network.collision.bindMapReasonLabel"]()}:</span>
					{resolveMessageKey(mappingBand.reasonKey)}
				</p>
			{/if}
			{#if mappingBand.collisions.length > 0}
				<ul class="flex flex-col gap-1 pt-0.5">
					{#each mappingBand.collisions as group (group.ip + group.effective_index)}
						<li
							data-testid="bond-mapping-collision"
							data-ip={group.ip}
							class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
						>
							<code
								class="bg-status-warning/10 text-status-warning rounded-md px-1.5 py-0.5 font-mono text-xs"
								>{group.ip}</code
							>
							<span class="text-muted-foreground text-xs">
								{m["network.collision.bindMapCollisionLines"]({
									kept: group.effective_index + 1,
									excluded: group.excluded_indices.map((index) => index + 1).join(', '),
								})}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}
