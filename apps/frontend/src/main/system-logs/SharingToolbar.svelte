<!--
  SharingToolbar.svelte: the logs toolbar's two sharing actions, in the tab
  strip's row so they show without scrolling at every width: Support bundle in
  outline, then Export logs, the view's one filled primary action (DESIGN.md
  IH-5). Each opens the same confirmation as its Downloads row, through the
  view's SharingFlow, so nothing downloads before that dialog. Below 640 px the
  group is a touch region (app.css), so a thumb gets 44 px targets. When both
  labels do not fit one row (Japanese at 320 px, German at 375 px), the second
  button moves to its own row instead of breaking a word; a label too long for
  a whole row wraps inside its button with words kept whole, as in the
  Downloads rows.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Download, LifeBuoy } from '@lucide/svelte';
import type { ClassValue } from 'svelte/elements';

import { Button } from '$lib/components/ui/button';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import KeepWords from './KeepWords.svelte';

let {
	sharing,
	class: className,
	bundleButton = $bindable(null),
	exportButton = $bindable(null),
}: {
	sharing: SharingFlow;
	class?: ClassValue;
	bundleButton?: HTMLElement | null;
	exportButton?: HTMLElement | null;
} = $props();
</script>

<fieldset
	aria-label={m['systemLogs.sharing.heading']()}
	class={[
		'flex min-w-0 flex-wrap items-center gap-2 [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word',
		className,
	]}
	data-testid="sharing-toolbar"
	data-touch-region
>
	<Button
		bind:ref={bundleButton}
		class="h-auto max-w-full gap-1.5 py-1.5 whitespace-normal max-sm:flex-auto"
		data-testid="sharing-toolbar-bundle"
		data-variant="outline"
		onclick={() => void sharing.openBundle()}
		variant="outline"
	>
		<LifeBuoy aria-hidden="true" class="size-4" />
		<span><KeepWords text={m['systemLogs.sharing.bundle']()} /></span>
	</Button>
	<Button
		bind:ref={exportButton}
		class="h-auto max-w-full gap-1.5 py-1.5 whitespace-normal max-sm:flex-auto"
		data-testid="sharing-toolbar-export"
		data-variant="default"
		onclick={() => sharing.openExport()}
	>
		<Download aria-hidden="true" class="size-4" />
		<span><KeepWords text={m['systemLogs.sharing.exportLogs']()} /></span>
	</Button>
</fieldset>
