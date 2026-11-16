<script lang="ts">
/**
 * ProgramDesk — the picture leads the Live screen (Live screen contract).
 *
 * Hosts the ONE `PreviewDisclosure` (and with it the one `PreviewCanvas`) and,
 * after it, whatever the cockpit hands in: `layout-controls` idle; the "Now
 * streaming" summary, the live source switch and `layout-controls` live. It is a
 * plain column, not a card: every child is already its own surface.
 */
import type { CompositionConfig } from '@ceraui/rpc/schemas';
import type { Snippet } from 'svelte';

import PreviewDisclosure from './PreviewDisclosure.svelte';

interface Props {
	/** Marks the mid-stream mount of the preview. */
	streaming?: boolean;
	/** The saved composition to place on the preview, when the engine can place it freely. */
	placement?: CompositionConfig | undefined;
	class?: string;
	children?: Snippet;
}

const { streaming = false, placement = undefined, class: className = '', children }: Props = $props();
</script>

<div class="flex min-w-0 flex-col gap-6 {className}" data-testid="program-desk">
	<PreviewDisclosure {placement} {streaming} />
	{@render children?.()}
</div>
