<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronDown, Wifi } from '@lucide/svelte';

import * as Collapsible from '$lib/components/ui/collapsible';

type WindowInfo = {
	width: number;
	height: number;
	devicePixelRatio: number;
	colorScheme: string;
	reducedMotion: boolean;
	screenWidth: number;
	screenHeight: number;
};

let { windowInfo }: { windowInfo: WindowInfo } = $props();

let preferencesOpen = $state(false);
</script>

<!-- User Preferences -->
<Collapsible.Root bind:open={preferencesOpen}>
	<Collapsible.Trigger class="flex w-full cursor-pointer items-center justify-between text-sm font-medium hover:text-primary transition-colors">
		<div class="flex items-center gap-2">
			<Wifi class="h-4 w-4" />
			{$LL.devtools.userPreferencesAccessibility()}
		</div>
		<ChevronDown class="h-4 w-4 text-muted-foreground transition-transform duration-200 {preferencesOpen ? 'rotate-180' : ''}" />
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.colorScheme()}</div>
				<div class="font-mono text-sm font-medium">{windowInfo.colorScheme}</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.reducedMotion()}</div>
				<div
					class="font-mono text-sm font-medium {windowInfo.reducedMotion
						? 'text-status-warning'
						: 'text-status-success'}"
				>
					{windowInfo.reducedMotion ? $LL.devtools.enabled() : $LL.devtools.disabled()}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browserLanguages()}</div>
				<div
					class="truncate font-mono text-xs font-medium"
					title={navigator.languages ? navigator.languages.join(', ') : navigator.language}
				>
					{navigator.languages ? navigator.languages.slice(0, 2).join(', ') : navigator.language}
					{navigator.languages && navigator.languages.length > 2
						? `... (+${navigator.languages.length - 2})`
						: ''}
				</div>
			</div>
		</div>
	</Collapsible.Content>
</Collapsible.Root>
