<script lang="ts">
/**
 * ProgramDesk — the picture leads the Live screen (Live screen contract).
 *
 * Hosts the ONE `PreviewDisclosure` (and with it the one `PreviewCanvas`) and,
 * after it, whatever the cockpit hands in: `layout-controls` idle; the "Now
 * streaming" summary, the live source switch and `layout-controls` live. It is a
 * plain column, not a card: every child is already its own surface.
 */
import type { Snippet } from 'svelte';

import PreviewDisclosure from './PreviewDisclosure.svelte';

interface Props {
	/** Marks the mid-stream mount of the preview. */
	streaming?: boolean;
	class?: string;
	children?: Snippet;
}

const { streaming = false, class: className = '', children }: Props = $props();
</script>

<div class="flex min-w-0 flex-col gap-6 {className}" data-testid="program-desk">
	<PreviewDisclosure {streaming} />
	{@render children?.()}
</div>
