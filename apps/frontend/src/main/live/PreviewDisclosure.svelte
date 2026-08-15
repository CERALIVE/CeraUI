<script lang="ts">
/**
 * PreviewDisclosure — the collapsed local-preview `<details>` and its canvas.
 *
 * Extracted from IdleCockpit so BOTH cockpits can mount it. The engine attaches
 * its MSE publisher during an active session (wave2 todo 14e), but the only
 * surface that rendered this lived in IdleCockpit, which LiveView unmounts the
 * moment a stream starts — so mid-stream preview shipped with no UI at all.
 *
 * Exactly one instance is on screen at a time (LiveView renders one cockpit), so
 * there is never a second PreviewCanvas competing for the preview socket.
 *
 * `PreviewEncodeControl` hangs off this host rather than off the canvas: it is a
 * config + status surface with no involvement in the socket, the token mint or
 * the delivery-tier ladder, and it renders nothing at all unless the board
 * published `preview_hw_capability`.
 *
 * `PreviewCanvas` is unchanged: it still mints a single-use token over the
 * authenticated RPC socket and dials the backend-origin `/preview` proxy, and it
 * stays fully off (no engine dial) until `open` flips.
 */
import { LL } from '@ceraui/i18n/i18n-svelte5';

import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';

import PreviewEncodeControl from './PreviewEncodeControl.svelte';

interface Props {
	/** Marks the mid-stream mount so tests and CSS can tell the two apart. */
	streaming?: boolean;
}

const { streaming = false }: Props = $props();

let open = $state(false);
</script>

<details
	bind:open
	class="bg-card rounded-xl border"
	data-streaming={streaming ? 'true' : 'false'}
	data-testid="preview-disclosure"
>
	<summary class="cursor-pointer list-none px-4 py-3 text-sm font-medium select-none">
		{$LL.live.modes.preview()}
	</summary>
	<div class="px-4 pb-4">
		<PreviewCanvas hostActive={open} />
		<PreviewEncodeControl />
	</div>
</details>
