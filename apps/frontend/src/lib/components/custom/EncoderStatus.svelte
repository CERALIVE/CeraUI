<script lang="ts">
import type { Snippet } from 'svelte';
import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
import { getIsConnected } from '$lib/rpc/subscriptions.svelte';
import { acquireHealthClock, getHealthClockTick } from '$lib/stores/device-health-history.svelte';
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';
import { isMediaLoadStale } from '$lib/streaming/media-load';
import LegacyEncoderStatus from './LegacyEncoderStatus.svelte';
import MediaLoadHint from './MediaLoadHint.svelte';

interface Props {
	readonly reading: EncoderLoadReading;
	readonly density?: 'panel' | 'inline';
	readonly compact?: boolean;
	readonly headerAside?: Snippet;
	readonly showDecoders?: boolean;
}

const { reading, density = 'panel', compact = false, headerAside, showDecoders = false }: Props = $props();
const MediaLoadDialog = lazyDialog(() => import('../../../main/dialogs/MediaLoadDialog.svelte'));
let detailOpen = $state(false);
const watching = $derived(Boolean(reading.blocks?.length) || detailOpen);
const stale = $derived(watching && !reading.simulated && (!getIsConnected() || isMediaLoadStale(reading, getHealthClockTick())));
$effect(() => { if (watching) return acquireHealthClock(); });
</script>

{#if reading.blocks?.length}
	<MediaLoadHint {reading} {density} {compact} {headerAside} {stale} onDetails={() => { detailOpen = true; }} />
{:else}
	<LegacyEncoderStatus {reading} {density} {compact} {headerAside} {showDecoders} />
{/if}
<LazyDialog dialog={MediaLoadDialog} bind:open={detailOpen} {reading} {stale} />
