<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronDown, Monitor } from '@lucide/svelte';

import * as Collapsible from '$lib/components/ui/collapsible';

type NetworkConnection = {
	effectiveType?: string;
	downlink?: number;
	rtt?: number;
} | null;

type SystemInfo = {
	browser: string;
	version: string;
	platform: string;
	cookieEnabled: boolean;
	onLine: boolean;
	connection: NetworkConnection;
};

type WindowInfo = {
	width: number;
	height: number;
	devicePixelRatio: number;
	colorScheme: string;
	reducedMotion: boolean;
	screenWidth: number;
	screenHeight: number;
};

let { systemInfo, windowInfo }: { systemInfo: SystemInfo; windowInfo: WindowInfo } = $props();

let browserInfoOpen = $state(false);
</script>

<!-- Browser Information -->
<Collapsible.Root bind:open={browserInfoOpen}>
	<Collapsible.Trigger class="flex w-full cursor-pointer items-center justify-between text-sm font-medium hover:text-primary transition-colors">
		<div class="flex items-center gap-2">
			<Monitor class="h-4 w-4" />
			{$LL.devtools.browserInformation()}
		</div>
		<ChevronDown class="h-4 w-4 text-muted-foreground transition-transform duration-200 {browserInfoOpen ? 'rotate-180' : ''}" />
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browser()}</div>
				<div class="font-mono text-sm font-medium">{systemInfo.browser} {systemInfo.version}</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.platform()}</div>
				<div class="font-mono text-sm font-medium">{systemInfo.platform}</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.userAgent()}</div>
				<div class="truncate font-mono text-xs" title={navigator.userAgent}>
					{navigator.userAgent.slice(0, 25)}...
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.onlineStatus()}</div>
				<div
					class="font-mono text-sm font-medium {systemInfo.onLine
						? 'text-status-success'
						: 'text-status-error'}"
				>
					{systemInfo.onLine ? $LL.devtools.online() : $LL.devtools.offline()}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.cookies()}</div>
				<div
					class="font-mono text-sm font-medium {systemInfo.cookieEnabled
						? 'text-status-success'
						: 'text-status-error'}"
				>
					{systemInfo.cookieEnabled ? $LL.devtools.enabled() : $LL.devtools.disabled()}
				</div>
			</div>
			<div class="bg-background/50 rounded-lg border p-3">
				<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.pixelRatio()}</div>
				<div class="font-mono text-sm font-medium">{windowInfo.devicePixelRatio}x</div>
			</div>
		</div>
	</Collapsible.Content>
</Collapsible.Root>
