<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Code } from '@lucide/svelte';

type BuildInfo = {
	mode: string;
	nodeEnv: string;
	dev: boolean;
	socketEndpoint: string;
	socketPort: string;
	clientVersion: string;
	timestamp: string;
};

let { buildInfo }: { buildInfo: BuildInfo } = $props();
</script>

<!-- Build Information -->
<div class="space-y-3">
	<div class="flex items-center gap-2 text-sm font-medium">
		<Code class="h-4 w-4" />
		{$LL.devtools.buildInformation()}
	</div>
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.mode()}</div>
			<div class="font-mono text-sm font-medium">{buildInfo.mode}</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.nodeEnv()}</div>
			<div class="font-mono text-sm font-medium">{buildInfo.nodeEnv}</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.devMode()}</div>
			<div
				class="font-mono text-sm font-medium {buildInfo.dev
					? 'text-status-success'
					: 'text-status-error'}"
			>
				{buildInfo.dev ? $LL.devtools.yes() : $LL.devtools.no()}
			</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.clientVersion()}</div>
			<div class="font-mono text-sm font-medium">{buildInfo.clientVersion}</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.socketEndpoint()}</div>
			<div class="truncate font-mono text-xs font-medium">{buildInfo.socketEndpoint}</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.socketPort()}</div>
			<div class="font-mono text-sm font-medium">{buildInfo.socketPort}</div>
		</div>
	</div>
</div>
