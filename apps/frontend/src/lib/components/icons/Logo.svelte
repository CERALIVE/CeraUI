<script lang="ts">
import type { HTMLAttributes } from 'svelte/elements';

interface Props extends HTMLAttributes<HTMLSpanElement> {}

let { class: className, ...restProps }: Props = $props();
</script>

<span class={['brand-logo', className]} data-testid="brand-logo" aria-hidden="true" {...restProps}>
	<img
		src="/brand/ceralive-mark-small-light.svg"
		alt=""
		draggable="false"
		class="size-full light-v"
		decoding="async"
	/>
	<img
		src="/brand/ceralive-mark-small-dark.svg"
		alt=""
		draggable="false"
		class="size-full dark-v"
		decoding="async"
	/>
	<img
		src="/brand/ceralive-mark-small-mono-ink.svg"
		alt=""
		draggable="false"
		class="size-full mono-v"
		decoding="async"
	/>
</span>

<style>
	.brand-logo {
		display: inline-block;
	}

	.dark-v,
	.mono-v {
		display: none;
	}

	:global(html.dark) .light-v {
		display: none;
	}

	:global(html.dark) .dark-v {
		display: block;
	}

	:global(html[data-display='eink']) .light-v,
	:global(html[data-display='eink']) .dark-v {
		display: none;
	}

	:global(html[data-display='eink']) .mono-v {
		display: block;
	}
</style>
