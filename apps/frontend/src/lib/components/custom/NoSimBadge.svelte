<!--
  NoSimBadge.svelte — the ONE "No SIM" tag, for every class of cellular device.

  It exists because the same physical condition used to render three different
  ways: a directly-managed modem collapsed it into its lifecycle badge
  (`network.cellular.state.noSim`), a router-mode dongle drew it inside the
  router-signal chip (`network.routerCellular.simAbsent`), and the config dialog
  banner used a THIRD glyph (`SignalZero`) — so an operator comparing a SIM-less
  modem against a SIM-less dongle saw two different colours, two different icons
  and two different words for one fact.

  The tag is the tag; the SURROUNDING copy stays per-class. A dongle still gets
  its "runs its own router" explanation and a modem still gets its "cannot bond"
  reasoning — those describe genuinely different devices. Only the pill is
  shared, so it can never drift again.

  `size` follows the host row: `micro` inline beside the other row pills, `sm`
  in the dialog banner where it leads a paragraph.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { CircleOff } from '@lucide/svelte';

import Badge from './Badge.svelte';

interface Props {
	/** Matches the host surface's pill scale; rows are `micro`, banners `sm`. */
	size?: 'sm' | 'micro';
	/** Overridden only where an existing selector must keep resolving. */
	testid?: string;
	class?: string;
	[key: string]: unknown;
}

let {
	size = 'micro',
	testid = 'modem-no-sim-badge',
	class: className = undefined,
	...rest
}: Props = $props();
</script>

<Badge
	{...rest}
	class={className}
	data-no-sim="true"
	data-testid={testid}
	{size}
	variant="warning"
>
	{#snippet icon()}
		<CircleOff class="size-3 shrink-0" aria-hidden="true" />
	{/snippet}
	{m["network.view.noSimLink"]()}
</Badge>
