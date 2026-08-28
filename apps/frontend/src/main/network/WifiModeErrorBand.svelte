<!--
  WifiModeErrorBand.svelte — a terminal mode-transition failure, as one band.

  It is its own component because the control that PRODUCES the failure and the
  surface that must REPORT it are no longer the same node. `WifiSection` moved
  the three-rung selector behind a "Mode" popover, and a popover the operator has
  already dismissed cannot carry an outcome — an outcome nobody can see is an
  outcome that did not happen. So the WiFi row HOSTS this band in its own card
  body, where it survives the popover closing, while `HotspotDialog` — whose
  selector is always on screen — keeps rendering it inline.

  Exactly ONE of the two renders it for a given adapter (`WifiModeSelector`'s
  `errorPlacement` prop decides), because one fact announced twice reads as two
  failures. The markup, the testid and the `data-error` token are the ones the
  selector carried before the split, so every existing assertion resolves against
  whichever surface hosts it.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { TriangleAlert } from '@lucide/svelte';

interface Props {
	device: string;
	/** i18n dot-path for the device's own typed reason. */
	errorKey: string;
	/** The raw failure token, for a machine-readable assertion. */
	error?: string;
}

const { device, errorKey, error }: Props = $props();
</script>

<div
	class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
	data-error={error}
	data-testid="wifi-mode-error-{device}"
	role="status"
>
	<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
	<div class="min-w-0">
		<p class="text-status-warning text-xs font-semibold">
			{m["network.wifiMode.error.title"]()}
		</p>
		<p class="text-muted-foreground mt-0.5 text-xs">
			{resolveMessageKey(errorKey)}
		</p>
	</div>
</div>
