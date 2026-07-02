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

  The existing duplicate-IPv4 path is a backend `netif_dup_ip` NOTIFICATION and is
  entirely separate from this component — it is neither read nor rendered here.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifMessage } from '@ceraui/rpc/schemas';
import { Info, TriangleAlert } from '@lucide/svelte';

interface Props {
	/** Live netif snapshot from `getNetif()`; `undefined` before the first push. */
	netif: NetifMessage | undefined;
}

const { netif }: Props = $props();

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

// policy_route_missing is only ever `true` when flagged (absent/false otherwise).
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
				{$LL.network.collision.sameSubnetTitle()}
			</p>
			<p class="text-muted-foreground text-sm">
				{$LL.network.collision.sameSubnetBody()}
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
				{$LL.network.collision.policyRouteTitle()}
			</p>
			<p class="text-muted-foreground text-sm">
				{$LL.network.collision.policyRouteBody()}
			</p>
		</div>
	</div>
{/if}
