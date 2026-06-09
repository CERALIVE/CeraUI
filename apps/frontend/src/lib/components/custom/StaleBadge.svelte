<!--
  StaleBadge.svelte — per-interface staleness marker for the Network sections.

  Shown next to a single WiFi / modem / Ethernet interface whose own telemetry
  aged past the global threshold while its siblings kept updating. Static (no
  animation) so it is safe under the e-ink freeze; the warning tint draws the
  eye without the alarm of an error colour.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Clock } from '@lucide/svelte';

import { cn } from '$lib/utils';

interface Props {
	class?: string;
	'data-stale-interface'?: string;
}

const { class: className = undefined, 'data-stale-interface': staleInterface = undefined }: Props =
	$props();
</script>

<span
	class={cn(
		'bg-status-warning/10 text-status-warning inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
		className,
	)}
	data-stale-interface={staleInterface}
	title={$LL.network.view.staleHint()}
>
	<Clock class="size-3" aria-hidden="true" />
	{$LL.network.view.stale()}
</span>
