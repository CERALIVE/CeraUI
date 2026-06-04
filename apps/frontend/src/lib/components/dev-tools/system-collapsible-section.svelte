<!--
  system-collapsible-section.svelte — shared collapsible chrome for the dev-tools
  system-info panels.

  Extracted from the byte-identical Collapsible.Root + Trigger header that was
  duplicated across system-browser-panel / system-locale-panel /
  system-preferences-panel. Only the icon, title and (formerly per-panel) open
  state differed — open state is now owned internally, identical default-closed
  behaviour. Panel-specific body markup is passed via the `children` snippet.
-->
<script lang="ts">
import type { Component, Snippet } from 'svelte';

import { ChevronDown } from '@lucide/svelte';

import * as Collapsible from '$lib/components/ui/collapsible';

let {
	icon,
	title,
	children,
}: { icon: Component<{ class?: string }>; title: string; children: Snippet } = $props();

const Icon = $derived(icon);

let open = $state(false);
</script>

<Collapsible.Root bind:open>
	<Collapsible.Trigger class="flex w-full cursor-pointer items-center justify-between text-sm font-medium hover:text-primary transition-colors">
		<div class="flex items-center gap-2">
			<Icon class="h-4 w-4" />
			{title}
		</div>
		<ChevronDown class="h-4 w-4 text-muted-foreground transition-transform duration-200 {open ? 'rotate-180' : ''}" />
	</Collapsible.Trigger>
	<Collapsible.Content>
		{@render children()}
	</Collapsible.Content>
</Collapsible.Root>
