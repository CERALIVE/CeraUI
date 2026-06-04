<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Activity } from '@lucide/svelte';

type PerformanceData = {
	loadTime: number;
	memory: number;
	timing: PerformanceNavigationTiming | null;
	loadTimeCalculated: boolean;
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

let {
	performanceData,
	windowInfo,
	formatMs,
}: {
	performanceData: PerformanceData;
	windowInfo: WindowInfo;
	formatMs: (ms: number) => string;
} = $props();
</script>

<!-- Performance Metrics -->
<div class="space-y-3">
	<div class="flex items-center gap-2 text-sm font-medium">
		<Activity class="h-4 w-4" />
		{$LL.devtools.livePerformanceMetrics()}
	</div>
	<div class="grid grid-cols-2 gap-3 md:grid-cols-4" aria-live="polite">
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.pageLoad()}</div>
			<div
				class="text-lg font-bold {performanceData.loadTime < 1000
					? 'text-status-success'
					: performanceData.loadTime < 3000
						? 'text-status-warning'
						: 'text-status-error'}"
			>
				{formatMs(performanceData.loadTime)}
			</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.jsMemory()}</div>
			<div
				class="text-lg font-bold {performanceData.memory < 50
					? 'text-status-success'
					: performanceData.memory < 100
						? 'text-status-warning'
						: 'text-status-error'}"
			>
				{performanceData.memory}MB
			</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.viewport()}</div>
			<div class="text-lg font-bold text-primary">
				{windowInfo.width}×{windowInfo.height}
			</div>
		</div>
		<div class="bg-background/50 rounded-lg border p-3">
			<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.screen()}</div>
			<div class="text-lg font-bold text-primary">
				{windowInfo.screenWidth}×{windowInfo.screenHeight}
			</div>
		</div>
	</div>
</div>
