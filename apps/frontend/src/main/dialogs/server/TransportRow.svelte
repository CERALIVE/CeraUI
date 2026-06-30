<!--
  TransportRow.svelte — the honest transport row.

  SRTLA is the only working transport (always-on SRT ARQ over link bonding), so it
  is the single active pill. RIST and SRT are calm, INERT roadmap affordances —
  never fake-interactive radios. Each roadmap pill binds to an open tech-debt
  entry; the static bindings the CI gate (scripts/check-tech-debt.mjs) verifies are
  the literal comments below:
    roadmap: data-debt-id="TD-rist-egress"
    roadmap: data-debt-id="TD-plain-srt-egress"
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
</script>

<div class="space-y-2">
	<div class="flex items-center gap-1">
		<span class="text-sm font-medium" id="transport-row-label">{$LL.settings.transportKind()}</span>
		<InfoPopover
			body={$LL.settings.transportKindHint()}
			testId="transport-row-info"
			title={$LL.settings.transportKind()}
		/>
	</div>

	<div aria-labelledby="transport-row-label" class="grid grid-cols-3 gap-1" data-testid="transport-row">
		<div
			class="border-primary/30 bg-primary/10 text-foreground flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-sm font-medium"
			data-protocol="srtla"
			data-testid="transport-srtla"
		>
			<span class="font-mono">SRTLA</span>
			<span
				class="text-primary inline-flex items-center gap-1 text-[0.65rem] leading-tight"
				data-testid="transport-srtla-active"
			>
				<span class="bg-primary size-1.5 shrink-0 rounded-full motion-safe:animate-pulse" aria-hidden={true}></span>
				{$LL.settings.transportActive()}
			</span>
		</div>

		<div
			class="text-muted-foreground/70 flex flex-col items-center gap-0.5 px-3 py-2 text-sm font-medium opacity-80"
			data-protocol="rist"
			data-testid="transport-rist"
		>
			<span class="font-mono">RIST</span>
			<ComingSoon debtId="TD-rist-egress" />
		</div>

		<div
			class="text-muted-foreground/70 flex flex-col items-center gap-0.5 px-3 py-2 text-sm font-medium opacity-80"
			data-protocol="srt"
			data-testid="transport-srt"
		>
			<span class="font-mono">SRT</span>
			<ComingSoon debtId="TD-plain-srt-egress" />
		</div>
	</div>
</div>
