<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Cpu } from '@lucide/svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';
import MediaLoadPanel from './device-health/MediaLoadPanel.svelte';

interface Props {
	open?: boolean;
	readonly reading: EncoderLoadReading;
	readonly stale?: boolean;
}
let { open = $bindable(false), reading, stale = false }: Props = $props();
</script>

<AppDialog bind:open title={m['settings.mediaLoad.title']()} description={m['settings.mediaLoad.description']()}
	icon={Cpu} contentClass="sm:max-w-2xl" hideFooter>
	<MediaLoadPanel {reading} {stale} />
</AppDialog>
