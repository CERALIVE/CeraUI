<!--
  ConnectionSection.svelte — which uplink the last update transfer chose, and
  what every candidate uplink answered (Todo 41).

  It is an OBSERVATION of the last selection, never a live reading and never a
  control: the transport selector runs per transfer, and this section shows the
  most recent run with its own timestamp. Every probe verdict is a keyed word
  (`probeStateKey`); a machine token never reaches the screen. `clear` is the
  absence of a finding and is not listed.
-->
<script lang="ts">
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateTransportSummary } from '@ceraui/rpc/schemas';

import Badge from '$lib/components/custom/Badge.svelte';
import {
	familyLabel,
	formatUpdateTime,
	probeStateKey,
	uplinkKindKey,
} from '$lib/updates/update-view';

interface Props {
	transport: UpdateTransportSummary | null | undefined;
}

let { transport }: Props = $props();

const locale = $derived(getLocale());
const checked = $derived(formatUpdateTime(transport?.checkedAt, locale));
</script>

<section aria-labelledby="updates-connection-heading" class="space-y-2.5" data-testid="updates-connection">
	<h3 class="text-sm font-semibold" id="updates-connection-heading">{m['settings.updates.connection.title']()}</h3>

	{#if !transport}
		<p class="text-muted-foreground px-1 text-sm" data-testid="update-connection-none">
			{m['settings.updates.connection.none']()}
		</p>
	{:else}
		<p class="text-muted-foreground flex flex-wrap gap-x-2 px-1 text-xs">
			<span>
				{transport.profile === 'os'
					? m['settings.updates.connection.profile.os']()
					: m['settings.updates.connection.profile.apt']()}
			</span>
			{#if checked}
				<span aria-hidden="true">·</span>
				<span>{m['settings.updates.connection.checked']({ time: checked })}</span>
			{/if}
		</p>

		{#if transport.status === 'none'}
			<p
				class="border-status-warning/40 bg-status-warning/10 rounded-lg border px-4 py-3 text-sm"
				data-testid="update-connection-no-healthy"
				role="status"
			>
				{m['settings.updates.connection.noHealthy']()}
			</p>
		{/if}

		<ul class="divide-border divide-y overflow-hidden rounded-lg border">
			{#each transport.findings as finding (`${finding.ifname}-${finding.family}`)}
				{@const inUse =
					transport.selected?.ifname === finding.ifname &&
					transport.selected?.family === finding.family}
				{@const verdicts = finding.states.filter((state) => state !== 'clear')}
				<li
					class="space-y-1.5 px-4 py-3"
					data-family={finding.family}
					data-ifname={finding.ifname}
					data-testid="update-connection-finding"
				>
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-mono text-sm" dir="ltr">{finding.ifname}</span>
						<span class="text-muted-foreground text-xs">
							{resolveMessageKey(uplinkKindKey(finding.kind))} · {familyLabel(finding.family)}
						</span>
						{#if inUse}
							<Badge label={m['settings.updates.connection.selected']()} variant="success" />
						{/if}
					</div>
					<div class="flex flex-wrap items-center gap-1.5">
						<Badge
							label={finding.healthy
								? m['settings.updates.connection.reachable']()
								: m['settings.updates.connection.unreachable']()}
							size="micro"
							variant={finding.healthy ? 'success' : 'warning'}
						/>
						{#if finding.metered}
							<Badge label={m['settings.updates.connection.metered']()} size="micro" variant="neutral" />
						{/if}
						<!-- A captive verdict already names the sign-in page; the flag only
						     speaks for a probe that detected one without saying how. -->
						{#if finding.captive && !verdicts.includes('captive-http') && !verdicts.includes('captive-tls')}
							<Badge label={m['settings.updates.connection.captive']()} size="micro" variant="warning" />
						{/if}
						{#each verdicts as state (state)}
							<Badge
								data-probe-state={state}
								label={resolveMessageKey(probeStateKey(state))}
								size="micro"
								variant="neutral"
							/>
						{/each}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
