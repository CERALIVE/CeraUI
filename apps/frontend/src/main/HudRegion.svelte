<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { cn } from '$lib/utils';

let { class: className }: { class?: string } = $props();
</script>

<!--
  Persistent HUD region. Placeholder shell for Task 9 — the live telemetry bar
  (bitrate / signal / SoC) mounts here in Task 10. It lives inside the
  authenticated MainView shell so it persists across Live / Network / Settings.
-->
<div
	data-hud-region
	role="status"
	aria-label={$LL.hud.status()}
	class={cn(
		'bg-sidebar text-muted-foreground flex h-10 items-center gap-2.5 border-t px-4 text-xs font-medium tracking-wide',
		className,
	)}
>
	<span class="bg-primary inline-block h-2 w-2 shrink-0 animate-pulse rounded-full"></span>
	<span class="uppercase">{$LL.hud.status()}</span>
	<span class="text-muted-foreground/60 truncate">{$LL.hud.noData()}</span>
</div>
