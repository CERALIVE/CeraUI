<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

interface Props {
	/**
	 * The rate the engine is CURRENTLY applying (already formatted). Under
	 * adaptive bitrate this sits below the configured ceiling — see `bitrateLimit`.
	 */
	bitrate: string;
	/**
	 * The configured ceiling, formatted — supplied ONLY while the engine is
	 * proven to be encoding below it, so the operator can see their setting was
	 * honoured as a limit rather than ignored. Absent otherwise.
	 */
	bitrateLimit?: string | undefined;
	tempSensor?: string;
	uptimeSensor?: string;
}

const { bitrate, bitrateLimit, tempSensor, uptimeSensor }: Props = $props();
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
		<p class="flex items-baseline gap-1.5 font-mono text-lg font-semibold">
			<span data-testid="telemetry-bitrate" style="color: var(--status-live);">{bitrate}</span>
			{#if bitrateLimit}
				<span
					class="text-muted-foreground/70 text-xs font-normal"
					data-testid="telemetry-bitrate-limit"
					title={$LL.hud.bitrateBelowLimitHint()}
				>
					/ {bitrateLimit}
				</span>
			{/if}
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
