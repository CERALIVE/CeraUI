<!--
  WifiModeBadge.svelte — the adapter's mode, as one word.

  It exists so a surface that only REPORTS the mode (HotspotSection's card, the
  WifiSection row's identity line) speaks the same three-word vocabulary as the
  control that CHANGES it. Before this, the hotspot card said "WiFi + AP" or
  "Active" while the WiFi row said "AP active" — two renderings of one fact, and
  no shared word for either.

  THE WORD IS NOT THE ONLY CHANNEL. `hotspot` and `hybrid` share the `status-info`
  tone — truthfully, since both broadcast — so colour alone separates only
  station from the pair. At 375px, glanced rather than read, that left the two AP
  modes looking like one state. Each mode therefore carries its OWN GLYPH, which
  is this repo's standing rule everywhere else a state is rendered (`EncoderStatus`,
  the dongle lifecycle badges, the router link badge): a state is carried by a WORD
  and a SHAPE, and colour only reinforces them. The glyph is `aria-hidden` — it adds
  nothing for assistive tech, which already reads the word.
-->
<script lang="ts">
import { resolveMessageKey } from '@ceraui/i18n/svelte';
import type { WifiAdapterMode } from '@ceraui/rpc/schemas';
import { RadioTower, Waypoints, Wifi } from '@lucide/svelte';

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

// One glyph per mode: associated to an AP (station), broadcasting one (hotspot),
// doing both at once (hybrid). Total over the enum, so a fourth mode fails `tsc`
// rather than reaching an operator as an unmarked pill.
const GLYPH: Record<WifiAdapterMode, typeof Wifi> = {
	station: Wifi,
	hotspot: RadioTower,
	hybrid: Waypoints,
};

const Glyph = $derived(GLYPH[mode]);
</script>

<span
	class={cn(
		'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
		TONE[mode],
		className,
	)}
	data-device={device}
	data-mode={mode}
	data-testid="wifi-mode-badge"
>
	<Glyph aria-hidden="true" class="size-3 shrink-0" />
	{resolveMessageKey(wifiModeLabelKey(mode))}
</span>
