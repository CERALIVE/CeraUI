<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Wifi } from '@lucide/svelte';

import SystemCollapsibleSection from '$lib/components/dev-tools/system-collapsible-section.svelte';

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
</script>

<!-- User Preferences -->
<SystemCollapsibleSection icon={Wifi} title={$LL.devtools.userPreferencesAccessibility()}>
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
</SystemCollapsibleSection>
