<!--
  StreamStatePill.svelte: the stream state in the System Logs header: Live, Idle
  or Offline, read from the same HUD state as the top bar and styled like its
  lead badge. Live is the only lime in the view, because it is the live signal.
  The live and idle tokens are not registered Tailwind colours (`bg-status-live`
  generates nothing), so the pill reads them as CSS variables.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import ClockIcon from '@lucide/svelte/icons/clock';

import { type StreamPillState, streamPillState } from '$lib/device-logs/stream-pill';
import { getHudState } from '$lib/stores/hud.svelte';
import { cn } from '$lib/utils';

const TONE: Record<StreamPillState, string> = {
	live: 'bg-(--status-live) text-primary-foreground',
	idle: 'text-muted-foreground',
	offline: 'bg-muted text-muted-foreground',
};

const hud = $derived(getHudState());
const pill = $derived(streamPillState(hud.isStreaming, hud.isFullyStale));
</script>

<span
	class={cn(
		'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider',
		TONE[pill],
	)}
	data-state={pill}
	data-testid="system-logs-stream-pill"
>
	{#if pill === 'live'}
		<span class="size-2 rounded-full bg-current motion-safe:animate-pulse" data-pill-dot></span>
		{m["hud.live"]()}
	{:else if pill === 'offline'}
		<ClockIcon aria-hidden="true" class="size-3" />
		{m["hud.offline"]()}
	{:else}
		<span class="bg-(--status-idle) size-2 rounded-full" data-pill-dot></span>
		{m["hud.idle"]()}
	{/if}
</span>
