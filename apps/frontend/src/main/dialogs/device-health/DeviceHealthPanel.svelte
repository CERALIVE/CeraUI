<!--
  DeviceHealthPanel.svelte — the instrument itself.

  Four horizontal bands, no columns, no nested cards:
    1. now strip    — the three current facts, and the accessible primary
    2. trace field  — the strip recorder (HealthTraceField)
    3. encoder      — engine condition + per-core load in its honest state
    4. power rails  — a provable statement, not an em-dash

  It is deliberately SEPARATE from `DeviceHealthDialog.svelte`, which is a thin
  AppDialog shell. `SettingsView` mounts every dialog permanently (closed), and
  AppDialog renders its children only while open — so keeping the panel here is
  what guarantees the whole telemetry graph is read exactly when the operator is
  looking at it, and never on an ordinary Settings render. This mirrors the
  `dialogs/server/` split.

  Three things it refuses to fake
  -------------------------------
  1. **CPU load is not encode load.** `cpuLoad1` is the system-wide 1-minute
     average — CeraUI's own backend, `srtla_send`, NetworkManager and everything
     else. The lane is labelled as exactly that, and the encoder's own state sits
     BESIDE it so an operator can correlate without the UI asserting causation.
  2. **Load is never a percentage.** Converting a load average needs the device's
     core count, which the frontend does not have — `navigator.hardwareConcurrency`
     describes the OPERATOR'S BROWSER. The lane plots the raw figure against a
     printed, self-scaling maximum, so the normalisation is disclosed.
  3. **Power rails are absent on shipping boards, and it says so.** An em-dash
     would read as "still loading". Board detection is fail-soft: only `rk3588`
     and `n100` assert not-instrumented; `generic` and an absent snapshot fall
     back to the weaker "No reading", because absence of evidence is never
     evidence.

  Per-core encoder load has its own three-state model — see
  `lib/streaming/encoder-load.ts`.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ENGINE_UNREACHABLE_REVISION } from '@ceraui/rpc/schemas';
import { Activity, Clock, Cpu, Thermometer, Zap } from '@lucide/svelte';
import { MediaQuery } from 'svelte/reactivity';

import EncoderStatus from '$lib/components/custom/EncoderStatus.svelte';
import HealthTraceField, {
	type RenderLane,
} from '$lib/components/custom/HealthTraceField.svelte';
import {
	type LaneSignalStatus,
	LOAD_DOMAIN_MIN_CEILING,
	LOAD_GAP_MS,
	TEMP_BUCKET_MS,
	TEMP_DOMAIN,
	TEMP_GAP_MS,
	trimWindow,
	windowStats,
} from '$lib/components/custom/health-trace-view';
import { Skeleton } from '$lib/components/ui/skeleton';
import { HEALTH_COMPACT_QUERY } from '$lib/layout';
import { deriveEncoderActivity } from '$lib/streaming/encoder-load';
import { getCapabilities, getRevisions, getSources, getStatus } from '$lib/rpc/subscriptions.svelte';
import {
	acquireHealthClock,
	getEncoderLoad,
	getHealthClockTick,
	getLoadSamples,
	getLoadStatus,
	getTemperatureSamples,
	getTemperatureStatus,
} from '$lib/stores/device-health-history.svelte';
import { getDisplayProfile, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { getSocTelemetry } from '$lib/stores/hud.svelte';
import { getStreamHealthRollup } from '$lib/stores/stream-health.svelte';
import { cn } from '$lib/utils';

const t = $derived($LL.settings.deviceHealth);

// Shared with DeviceHealthDialog so the shorter lanes, the collapsed now strip,
// and the dropped footer pivot together — see HEALTH_COMPACT_QUERY.
const isCompact = new MediaQuery(HEALTH_COMPACT_QUERY);

const frozen = $derived(prefersEinkTheme(getDisplayProfile()));

// The rings fill from app start (initDeviceHealthHistory in main.ts); only the
// wall-clock playhead needs to run, and only while the recorder is on screen.
$effect(() => acquireHealthClock());

const now = $derived(getHealthClockTick());
const tempSamples = $derived(getTemperatureSamples());
const loadSamples = $derived(getLoadSamples());
const tempStatus = $derived(getTemperatureStatus());
const loadStatus = $derived(getLoadStatus());
const encoderLoad = $derived(getEncoderLoad());

const tempStats = $derived(windowStats(trimWindow(tempSamples, now)));
const loadStats = $derived(windowStats(trimWindow(loadSamples, now)));

function formatTemp(value: number): string {
	return `${value.toFixed(1)} \u00b0C`;
}
function formatTempScale(value: number): string {
	return `${value}\u00b0`;
}
function formatLoad(value: number): string {
	return value.toFixed(2);
}
function formatLoadScale(value: number): string {
	return value.toFixed(0);
}
function formatSigned(value: number, digits: number): string {
	return `${value >= 0 ? '+' : '\u2212'}${Math.abs(value).toFixed(digits)}`;
}

const lanes = $derived<RenderLane[]>([
	{
		id: 'temp',
		label: t.lane.temp(),
		samples: tempSamples,
		domain: TEMP_DOMAIN,
		gapMs: TEMP_GAP_MS,
		bucketMs: TEMP_BUCKET_MS,
		degraded: tempStatus.state === 'aging' || tempStatus.state === 'unavailable',
		formatScale: formatTempScale,
	},
	{
		id: 'load',
		label: t.lane.load(),
		samples: loadSamples,
		domain: 'auto',
		autoMinCeiling: LOAD_DOMAIN_MIN_CEILING,
		gapMs: LOAD_GAP_MS,
		degraded: loadStatus.state === 'aging' || loadStatus.state === 'unavailable',
		formatScale: formatLoadScale,
	},
]);

const caps = $derived(getCapabilities());
const activeEncode = $derived(getStatus()?.active_encode);
const rollup = $derived(getStreamHealthRollup());
// The sentinel is PROSE, not a version, and the condition line beside it already
// says the engine is unreachable — rendering it here would present that sentence
// as a build number.
const engineRevision = $derived.by(() => {
	const revision = getRevisions()?.cerastream;
	return revision === ENGINE_UNREACHABLE_REVISION ? undefined : revision;
});

const encoderCondition = $derived.by(() => {
	if (caps?.engineUnavailable === true) return t.encoder.engineUnavailable();
	if (caps?.engineStarting === true) return t.encoder.engineStarting();
	if (activeEncode === undefined || activeEncode === null) return t.encoder.idle();
	const framerate = Number.isFinite(activeEncode.framerate) ? `${activeEncode.framerate}` : '';
	const summary = [activeEncode.codec, activeEncode.resolution, framerate]
		.filter((part) => part.length > 0)
		.join(' ');
	return t.encoder.active({ summary });
});

// `advancing === false` is the ONLY stall claim; `null` is the cold-start /
// idle-window branch and must never read as "stalled".
const framesVerdict = $derived.by(() => {
	const advancing = rollup?.frames.advancing;
	if (advancing === true) return t.encoder.framesAdvancing();
	if (advancing === false) return t.encoder.framesStalled();
	return t.encoder.framesUnknown();
});

const hardware = $derived(getSources()?.hardware);
const soc = $derived(getSocTelemetry());
const powerRails = $derived.by(() => {
	if (hardware === 'rk3588' || hardware === 'n100') {
		return { kind: 'not-instrumented' as const, text: t.power.notInstrumented() };
	}
	if (hardware === 'jetson' && (soc.voltage !== null || soc.current !== null)) {
		const parts = [
			soc.voltage === null ? null : `${soc.voltage.toFixed(2)} V`,
			soc.current === null ? null : `${soc.current.toFixed(2)} A`,
		].filter((part): part is string => part !== null);
		return { kind: 'live' as const, text: parts.join('  ') };
	}
	return { kind: 'no-reading' as const, text: t.power.noReading() };
});

const traceSummary = $derived.by(() => {
	const parts: string[] = [];
	if (tempStats !== null) {
		parts.push(
			`${t.lane.temp()} ${formatTemp(tempStats.last)} (${formatTemp(tempStats.min)} – ${formatTemp(tempStats.max)})`,
		);
	}
	if (loadStats !== null) {
		parts.push(
			`${t.nowStrip.load()} ${formatLoad(loadStats.last)} (${formatLoad(loadStats.min)} – ${formatLoad(loadStats.max)})`,
		);
	}
	return parts.length === 0 ? t.waiting() : parts.join(' \u00b7 ');
});

// The widget's headline is real text, not colour, and it belongs in the panel's
// EXISTING polite region rather than a second one competing with it.
const encoderHeadline = $derived.by(() => {
	const activity = deriveEncoderActivity(encoderLoad);
	if (activity === 'encoding') return t.cores.headlineEncoding();
	if (activity === 'idle') return t.cores.headlineIdle();
	return t.cores.headlineUnreported();
});

const announcement = $derived(
	[
		tempStatus.value === null ? null : formatTemp(tempStatus.value),
		loadStatus.value === null ? null : formatLoad(loadStatus.value),
		encoderCondition,
		`${t.cores.title()} ${encoderHeadline}`,
	]
		.filter((part): part is string => part !== null)
		.join(' \u00b7 '),
);

// Per-tick announcement would flood; reuse HudBar's debounce value.
const TELEMETRY_ANNOUNCE_DEBOUNCE_MS = 1500;
let announced = $state('');
$effect(() => {
	const next = announcement;
	const handle = setTimeout(() => {
		announced = next;
	}, TELEMETRY_ANNOUNCE_DEBOUNCE_MS);
	return () => clearTimeout(handle);
});
</script>

{#snippet engineRevisionChip()}
	{#if engineRevision}
		<span class="text-muted-foreground ms-auto truncate font-mono text-[11px]">{engineRevision}</span>
	{/if}
{/snippet}

{#snippet fact(
	label: string,
	icon: typeof Thermometer,
	status: LaneSignalStatus,
	format: (value: number) => string,
	secondary: string | null,
	testId: string,
)}
	{@const Icon = icon}
	<div class="min-w-0 space-y-1" data-testid={testId} data-state={status.state}>
		<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
			<Icon aria-hidden={true} class="size-3.5 shrink-0" />
			<span class="truncate">{label}</span>
		</span>
		{#if status.state === 'waiting'}
			<Skeleton class="h-5 w-24" data-testid="{testId}-skeleton" />
		{:else if status.value === null}
			<span
				class="text-muted-foreground/60 block font-mono text-sm"
				data-testid="{testId}-value"
				title={t.unavailable()}
				aria-label={t.unavailable()}
			>
				&mdash;
			</span>
		{:else}
			<span
				class={cn(
					'text-foreground flex items-center gap-1.5 font-mono text-sm tabular-nums',
					status.state === 'aging' && 'opacity-50',
				)}
				data-testid="{testId}-value"
			>
				{format(status.value)}
				{#if status.state === 'aging'}
					<Clock aria-hidden={true} class="size-3.5 shrink-0" />
				{/if}
				{#if isCompact.current && secondary !== null}
					<span class="text-muted-foreground/80 truncate text-[11px]">· {secondary}</span>
				{/if}
			</span>
		{/if}
		{#if secondary !== null && !isCompact.current}
			<span class="text-muted-foreground/80 block truncate font-mono text-[11px] tabular-nums">
				{secondary}
			</span>
		{/if}
	</div>
{/snippet}

<div class={cn(isCompact.current ? 'space-y-3' : 'space-y-4')} data-testid="device-health">
	<!-- Band 1 — the now strip. Always mounted: "no strip" must never be
	     confusable with "no data". It is also the accessible primary, so a
	     screen-reader user gets the same facts without the trace. -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="device-health-now">
		{@render fact(
			t.nowStrip.temperature(),
			Thermometer,
			tempStatus,
			formatTemp,
			tempStats === null ? null : t.delta({ value: formatSigned(tempStats.delta, 1) }),
			'health-fact-temp',
		)}
		{@render fact(
			t.nowStrip.load(),
			Cpu,
			loadStatus,
			formatLoad,
			loadStats === null ? null : t.peak({ value: formatLoad(loadStats.max) }),
			'health-fact-load',
		)}
		<div class="col-span-2 min-w-0 space-y-1 sm:col-span-1" data-testid="health-fact-encoder">
			<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
				<Activity aria-hidden={true} class="size-3.5 shrink-0" />
				<span class="truncate">{t.nowStrip.encoder()}</span>
			</span>
			<span class="text-foreground block text-sm" data-testid="health-fact-encoder-value">
				{encoderCondition}
				{#if isCompact.current}
					<span class="text-muted-foreground/80 text-[11px]">· {framesVerdict}</span>
				{/if}
			</span>
			{#if !isCompact.current}
				<span class="text-muted-foreground/80 block truncate text-[11px]">{framesVerdict}</span>
			{/if}
		</div>
	</div>

	<!-- Band 2 — the strip recorder. -->
	<HealthTraceField
		ariaLabel={t.traceLabel({ summary: traceSummary })}
		axisMinutesAgo={(minutes) => t.axis.minutesAgo({ n: minutes })}
		axisNowLabel={t.axis.now()}
		compact={isCompact.current}
		{frozen}
		gapLabel={t.gap()}
		{lanes}
		{now}
		waitingLabel={t.waiting()}
	/>

	<!-- Band 3 — the unified encoder widget. Its own header replaces this band's
	     former <h3>, so the word "Encoder" is printed once rather than twice. -->
	<section data-testid="device-health-encoder">
		<EncoderStatus
			compact={isCompact.current}
			density="panel"
			headerAside={engineRevisionChip}
			reading={encoderLoad}
		/>
	</section>

	<!-- Band 4 — power rails: a provable statement, never an em-dash. -->
	<section
		class="flex items-start gap-2.5 border-t pt-3"
		data-testid="device-health-power"
		data-power-state={powerRails.kind}
	>
		<Zap aria-hidden={true} class="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			<span class="block text-xs font-medium">{t.power.title()}</span>
			<span
				class={cn(
					'block text-xs leading-relaxed',
					powerRails.kind === 'live'
						? 'text-foreground font-mono tabular-nums'
						: 'text-muted-foreground',
				)}
				data-testid="device-health-power-value"
			>
				{powerRails.text}
			</span>
		</div>
	</section>

	<span aria-live="polite" class="sr-only" data-testid="device-health-announce" role="status">
		{announced}
	</span>
</div>
