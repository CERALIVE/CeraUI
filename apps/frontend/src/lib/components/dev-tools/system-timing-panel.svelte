<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Clock } from '@lucide/svelte';

type PerformanceData = {
	loadTime: number;
	memory: number;
	timing: PerformanceNavigationTiming | null;
	loadTimeCalculated: boolean;
};

let {
	performanceData,
	formatMs,
}: { performanceData: PerformanceData; formatMs: (ms: number) => string } = $props();
</script>

<!-- Performance Timing Details -->
{#if performanceData.timing}
	<div class="space-y-3">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Clock class="h-4 w-4" />
			Detailed Timing (Navigation API)
		</div>
		<div class="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.dnsLookup()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.domainLookupEnd - performanceData.timing.domainLookupStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.connect()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.connectEnd - performanceData.timing.connectStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.request()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.responseStart - performanceData.timing.requestStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.response()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.responseEnd - performanceData.timing.responseStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.domContent()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.domContentLoadedEventEnd -
							performanceData.timing.domContentLoadedEventStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.domComplete()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.domComplete -
							performanceData.timing.domContentLoadedEventEnd,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.loadEvent()}</div>
				<div class="font-mono">
					{Math.round(
						performanceData.timing.loadEventEnd - performanceData.timing.loadEventStart,
					)}ms
				</div>
			</div>
			<div class="bg-background/50 rounded border p-2">
				<div class="text-muted-foreground mb-1">{$LL.devtools.total()}</div>
				<div class="font-mono font-bold">{formatMs(performanceData.loadTime)}</div>
			</div>
		</div>
	</div>
{/if}
