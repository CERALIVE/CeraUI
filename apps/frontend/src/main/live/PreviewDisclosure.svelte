<script lang="ts">
/**
 * PreviewDisclosure — the local-preview `<details>` and its canvas.
 *
 * Extracted from IdleCockpit so BOTH cockpits can mount it. The engine attaches
 * its MSE publisher during an active session (wave2 todo 14e), but the only
 * surface that rendered this lived in IdleCockpit, which LiveView unmounts the
 * moment a stream starts — so mid-stream preview shipped with no UI at all.
 *
 * Exactly one instance is on screen at a time (LiveView renders one cockpit), so
 * there is never a second PreviewCanvas competing for the preview socket.
 *
 * Open state (Live screen contract): the operator's last choice, stored under
 * `ceraui.live.previewOpen`, wins; without one the disclosure is open from 768 px
 * up and closed below. The default is read once, at first render, so a resize
 * never flips it, and only the operator's own toggle is stored. Opening it only
 * reveals the surface: `PreviewCanvas` stays off (no engine dial) until its own
 * toggle is pressed.
 *
 * `PreviewEncodeControl` hangs off this host rather than off the canvas: it is a
 * config + status surface with no involvement in the socket, the token mint or
 * the delivery-tier ladder, and it renders nothing at all unless the board
 * published `preview_hw_capability`.
 *
 * While it is open and the cockpit hands in a `placement`, `LayoutDesigner` is
 * drawn over the picture so the second input can be placed on it. The open
 * state is published in `previewDisclosure` for the layout controls.
 */
import { m } from '@ceraui/i18n/svelte';
import type { CompositionConfig } from '@ceraui/rpc/schemas';

import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';

import LayoutDesigner from './LayoutDesigner.svelte';
import PreviewEncodeControl from './PreviewEncodeControl.svelte';
import { previewDisclosure } from './previewDisclosure.svelte';

interface Props {
	/** Marks the mid-stream mount so tests and CSS can tell the two apart. */
	streaming?: boolean;
	/** The saved composition to place, when the engine can place it freely. */
	placement?: CompositionConfig | undefined;
}

const { streaming = false, placement = undefined }: Props = $props();

const OPEN_KEY = 'ceraui.live.previewOpen';
const OPEN_BY_DEFAULT_QUERY = '(min-width: 768px)';

function initialOpen(): boolean {
	const stored = localStorage.getItem(OPEN_KEY);
	if (stored === 'true' || stored === 'false') return stored === 'true';
	return typeof window.matchMedia === 'function' && window.matchMedia(OPEN_BY_DEFAULT_QUERY).matches;
}

const startOpen = initialOpen();
let open = $state(startOpen);
previewDisclosure.open = startOpen;
// The browser also fires `toggle` for the state the element rendered with; only
// a change from the last known state is the operator's choice.
let lastOpen = startOpen;

function handleToggle(event: Event & { currentTarget: HTMLDetailsElement }) {
	const next = event.currentTarget.open;
	previewDisclosure.open = next;
	if (next === lastOpen) return;
	lastOpen = next;
	localStorage.setItem(OPEN_KEY, String(next));
}
</script>

<details
	bind:open
	class="bg-card rounded-xl border"
	data-streaming={streaming ? 'true' : 'false'}
	data-testid="preview-disclosure"
	ontoggle={handleToggle}
>
	<summary class="cursor-pointer list-none px-4 py-3 text-sm font-medium select-none">
		{m["live.modes.preview"]()}
	</summary>
	<div class="px-4 pb-4">
		<PreviewCanvas compact hostActive={open} overlay={open && placement !== undefined ? designer : undefined} />
		<PreviewEncodeControl />
	</div>
</details>

{#snippet designer(picture: { width: number; height: number })}
	{#if placement !== undefined}
		<LayoutDesigner
			composition={placement}
			pictureHeight={picture.height}
			pictureWidth={picture.width}
		/>
	{/if}
{/snippet}
