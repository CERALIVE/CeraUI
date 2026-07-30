<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

interface Props {
	/**
	 * The headline rate, already formatted: the MEASURED bond throughput when
	 * `bitrateMeasured` is true, otherwise the engine's target.
	 */
	bitrate: string;
	/**
	 * Whether `bitrate` is a real measurement. Drives the heading, because a
	 * setpoint rendered under a "Bitrate" label is the lie this card exists to
	 * stop telling — it reads the same whether media is flowing or not.
	 */
	bitrateMeasured?: boolean;
	/**
	 * The engine's target, formatted — supplied ONLY when the measurement has
	 * taken the headline, so the setpoint stays visible as context instead of
	 * masquerading as the reading.
	 */
	bitrateTarget?: string | undefined;
	/**
	 * The configured ceiling, formatted — supplied ONLY while the engine is
	 * proven to be encoding below it, so the operator can see their setting was
	 * honoured as a limit rather than ignored. Absent otherwise.
	 */
	bitrateLimit?: string | undefined;
	tempSensor?: string;
	uptimeSensor?: string;
}

const {
	bitrate,
	bitrateMeasured = false,
	bitrateTarget,
	bitrateLimit,
	tempSensor,
	uptimeSensor,
}: Props = $props();
</script>

<!-- Live telemetry strip — only meaningful while streaming -->
<section
	aria-label={$LL.live.overview()}
	class="bg-card flex flex-wrap items-center gap-x-10 gap-y-4 rounded-xl border px-5 py-4"
>
	<div class="space-y-1">
		<p
			class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
			data-testid="telemetry-bitrate-heading"
			title={bitrateMeasured ? $LL.hud.bitrateMeasuredHint() : $LL.hud.bitrateTargetHint()}
		>
			{bitrateMeasured ? $LL.hud.bitrate() : $LL.hud.bitrateTarget()}
		</p>
		<p class="flex items-baseline gap-1.5 font-mono text-lg font-semibold">
			<span data-testid="telemetry-bitrate" style="color: var(--status-live);">{bitrate}</span>
			{#if bitrateTarget}
				<span
					class="text-muted-foreground/70 text-xs font-normal"
					data-testid="telemetry-bitrate-target"
					title={$LL.hud.bitrateTargetHint()}
				>
					{$LL.hud.bitrateTarget()} {bitrateTarget}
				</span>
			{/if}
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
