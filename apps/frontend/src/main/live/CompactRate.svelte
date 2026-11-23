<script lang="ts">
/**
 * CompactRate — a bitrate with its unit stacked: "3.6 Mb/s" with "Mb" over
 * "s", in the line height of the number, so a large phone readout stays
 * narrow. Screen readers get the plain formatted text.
 */
import { bitrateDisplay } from './bitrate-display';

interface Props {
	kbps: number | undefined;
}

const { kbps }: Props = $props();
const parts = $derived(bitrateDisplay(kbps));
</script>

{#if parts}
	<span class="inline-flex items-center" dir="ltr" role="img" aria-label={parts.label}>
		<span aria-hidden={true}>{parts.number}</span>
		<span
			aria-hidden={true}
			class="ms-1 inline-flex flex-col items-stretch text-center text-[0.42em] leading-[1.05] font-semibold"
		>
			<span>{parts.unit}</span>
			<span class="border-t border-current">s</span>
		</span>
	</span>
{:else}
	<span>—</span>
{/if}
