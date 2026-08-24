<!--
  WifiModeBadge.svelte — the adapter's mode, as one word.

  It exists so a surface that only REPORTS the mode (HotspotSection's card, the
  WifiSection row's identity line) speaks the same three-word vocabulary as the
  control that CHANGES it. Before this, the hotspot card said "WiFi + AP" or
  "Active" while the WiFi row said "AP active" — two renderings of one fact, and
  no shared word for either.
-->
<script lang="ts">
import { resolveMessageKey } from '@ceraui/i18n/svelte';
import type { WifiAdapterMode } from '@ceraui/rpc/schemas';

import { cn } from '$lib/utils';

import { wifiModeLabelKey } from './wifi-adapter-mode-view';

interface Props {
	device: string;
	mode: WifiAdapterMode;
	class?: string;
}

const { device, mode, class: className }: Props = $props();

const TONE: Record<WifiAdapterMode, string> = {
	station: 'border-primary/40 bg-primary/10 text-primary',
	hotspot: 'border-status-info/40 bg-status-info/10 text-status-info',
	hybrid: 'border-status-info/40 bg-status-info/10 text-status-info',
};
</script>

<span
	class={cn(
		'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-xs font-medium',
		TONE[mode],
		className,
	)}
	data-device={device}
	data-mode={mode}
	data-testid="wifi-mode-badge"
>
	{resolveMessageKey(wifiModeLabelKey(mode))}
</span>
