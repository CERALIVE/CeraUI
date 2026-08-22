<!--
  UnclaimedAdaptersBand.svelte — "the adapter is there; nothing is driving it".

  A wireless or Bluetooth adapter the kernel enumerated but bound NO driver to
  owns no network interface, no wiphy and no modem — so the Wi-Fi and Cellular
  sections above render EMPTY and read exactly like "nothing is plugged in".
  This band is the honest answer to that silence, and it is the whole of its job:

    • it is CALM and INFORMATIONAL (the `same-subnet-info` register, never the
      amber warning one). Nothing is broken and nothing the operator did caused
      it — the part simply needs a firmware package or a newer kernel.
    • it NEVER GATES. There is not one interactive element in here: no toggle,
      no button, no link, no control it could disable. It states a fact.

  SCOPE, stated because its limit is easy to mistake for a bug: the backend probe
  reads sysfs, so it can only speak for devices the kernel ENUMERATED. A PCIe
  function that never comes up at all is invisible to sysfs and therefore absent
  from this band. That is expected and documented — inventing a row for hardware
  the kernel never listed would be the opposite of what this exists to do.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UnclaimedAdapter } from '@ceraui/rpc/schemas';
import { Info } from '@lucide/svelte';

interface Props {
	/**
	 * `undefined` means the device never answered the question (an older backend,
	 * or a boot that has not reached the first probe); `[]` is the positive
	 * answer that every adapter on this host is driven. Both render nothing, but
	 * they are not the same fact and must not be collapsed upstream.
	 */
	adapters?: UnclaimedAdapter[] | undefined;
}

const { adapters = undefined }: Props = $props();

const rows = $derived(adapters ?? []);
</script>

{#if rows.length > 0}
	<!-- CALM / INFORMATIONAL — neutral info styling, never a warning colour. -->
	<div
		data-testid="unclaimed-adapters-info"
		role="status"
		class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-xl border p-4"
	>
		<Info class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-semibold tracking-tight" data-testid="unclaimed-adapters-title">
				{#if rows.length === 1}
					{m["network.unclaimedAdapters.titleOne"]()}
				{:else}
					{m["network.unclaimedAdapters.titleMany"]({ count: rows.length })}
				{/if}
			</p>
			<p class="text-muted-foreground text-sm">
				{m["network.unclaimedAdapters.body"]()}
			</p>
			<ul class="flex flex-col gap-1 pt-0.5">
				{#each rows as adapter (`${adapter.bus}:${adapter.vendorId}:${adapter.deviceId}`)}
					<li
						data-testid="unclaimed-adapter"
						data-bus={adapter.bus}
						data-kind={adapter.kind}
						class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
					>
						<span class="text-sm">
							{resolveMessageKey(`network.unclaimedAdapters.kind.${adapter.kind}`)}
						</span>
						<span class="text-muted-foreground text-xs">
							{resolveMessageKey(`network.unclaimedAdapters.bus.${adapter.bus}`)}
						</span>
						<code
							data-testid="unclaimed-adapter-id"
							dir="ltr"
							class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 font-mono text-xs"
							>{adapter.vendorId}:{adapter.deviceId}</code
						>
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
