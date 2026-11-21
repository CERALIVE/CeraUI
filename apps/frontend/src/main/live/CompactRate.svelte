<script lang="ts">
/**
 * CompactRate — a bitrate with its unit stacked: "3.6 Mb/s" with "Mb" over
 * "s", in the line height of the number, so a large phone readout stays
 * narrow. Screen readers get the plain formatted text. Anything that is not
 * "<number> Mbps" or "<number> kbps" renders as given.
 */
interface Props {
	/** The formatted rate, e.g. "3.6 Mbps". */
	value: string;
	class?: string;
}

const { value, class: className = '' }: Props = $props();

const parts = $derived.by(() => {
	const match = /^(.*\S)\s+([MmKk])bps$/.exec(value.trim());
	return match ? { number: match[1], top: `${match[2] === 'k' || match[2] === 'K' ? 'k' : 'M'}b` } : undefined;
});
</script>

{#if parts}
	<span class="inline-flex items-center {className}" data-compact-rate>
		<span class="sr-only">{value}</span>
		<span aria-hidden={true}>{parts.number}</span>
		<span
			aria-hidden={true}
			class="ms-1 inline-flex flex-col items-stretch text-center text-[0.42em] leading-[1.05] font-semibold"
		>
			<span>{parts.top}</span>
			<span class="border-t border-current">s</span>
		</span>
	</span>
{:else}
	<span class={className}>{value}</span>
{/if}
