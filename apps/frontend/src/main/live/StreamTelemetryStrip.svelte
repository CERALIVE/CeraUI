<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

interface Props {
	bitrate: string;
	tempSensor?: string;
	uptimeSensor?: string;
}

const { bitrate, tempSensor, uptimeSensor }: Props = $props();
</script>

<!-- Live telemetry strip — only meaningful while streaming -->
<section
	aria-label={$LL.live.overview()}
	class="bg-card flex flex-wrap items-center gap-x-10 gap-y-4 rounded-xl border px-5 py-4"
>
	<div class="space-y-1">
		<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
			{$LL.hud.bitrate()}
		</p>
		<p class="font-mono text-lg font-semibold" style="color: var(--status-live);">
			{bitrate}
		</p>
	</div>
	{#if tempSensor}
		<div class="space-y-1">
			<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{$LL.hud.temperature()}
			</p>
			<p class="font-mono text-lg font-semibold">{tempSensor}</p>
		</div>
	{/if}
	{#if uptimeSensor}
		<div class="space-y-1">
			<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{$LL.hud.uptime()}
			</p>
			<p class="font-mono text-lg font-semibold">{uptimeSensor}</p>
		</div>
	{/if}
</section>
