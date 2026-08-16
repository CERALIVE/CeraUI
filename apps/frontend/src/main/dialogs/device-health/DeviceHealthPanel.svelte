<!--
  DeviceHealthPanel.svelte — the instrument itself.

  Four horizontal bands, no columns, no nested cards:
    1. now strip    — the current facts, and the accessible primary. Three
                      always (temperature, load, encoder) plus GPU and DDR load
                      on the boards that report them
    2. trace field  — the strip recorder (HealthTraceField), three channels
    3. encoder      — engine condition + per-core encode/decode load, honestly
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
import { m } from '@ceraui/i18n/svelte';
import { ENGINE_UNREACHABLE_REVISION } from '@ceraui/rpc/schemas';
import { Activity, Clock, Cpu, Gauge, MemoryStick, Thermometer, Zap } from '@lucide/svelte';
import { MediaQuery } from 'svelte/reactivity';

import EncoderStatus from '$lib/components/custom/EncoderStatus.svelte';
import HealthTraceField, {
	type RenderLane,
} from '$lib/components/custom/HealthTraceField.svelte';
import {
	type LaneSignalStatus,
	LOAD_DOMAIN_MIN_CEILING,
	LOAD_GAP_MS,
	MEMORY_DOMAIN,
	MEMORY_GAP_MS,
	TEMP_BUCKET_MS,
	TEMP_DOMAIN,
	TEMP_GAP_MS,
	trimWindow,
	windowStats,
} from '$lib/components/custom/health-trace-view';
import { Skeleton } from '$lib/components/ui/skeleton';
import { HEALTH_COMPACT_QUERY } from '$lib/layout';
import { deriveEncoderActivity } from '$lib/streaming/encoder-load';
import {
	getCapabilities,
	getDeviceStats,
	getRevisions,
	getSources,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import {
	acquireHealthClock,
	getEncoderLoad,
	getHealthClockTick,
	getLoadSamples,
	getLoadStatus,
	getMemorySamples,
	getMemoryStatus,
	getTemperatureSamples,
	getTemperatureStatus,
} from '$lib/stores/device-health-history.svelte';
import { getDisplayProfile, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { getSocTelemetry } from '$lib/stores/hud.svelte';
import { getStreamHealthRollup } from '$lib/stores/stream-health.svelte';
import { cn } from '$lib/utils';


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
const memorySamples = $derived(getMemorySamples());
const tempStatus = $derived(getTemperatureStatus());
const loadStatus = $derived(getLoadStatus());
const memoryStatus = $derived(getMemoryStatus());
const encoderLoad = $derived(getEncoderLoad());

const tempStats = $derived(windowStats(trimWindow(tempSamples, now)));
const loadStats = $derived(windowStats(trimWindow(loadSamples, now)));
const memoryStats = $derived(windowStats(trimWindow(memorySamples, now)));

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
function formatPercent(value: number): string {
	return `${value.toFixed(0)}%`;
}
function formatPercentScale(value: number): string {
	return `${value}%`;
}

// devfreq publishes Hz, and `cpuFreq` publishes kHz — the two must never meet in
// one formatter, so this one takes Hz and says so in its name.
function formatHz(hz: number): string {
	if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(2)} GHz`;
	if (hz >= 1_000_000) return `${Math.round(hz / 1_000_000)} MHz`;
	if (hz >= 1_000) return `${Math.round(hz / 1_000)} kHz`;
	return `${hz} Hz`;
}

const lanes = $derived<RenderLane[]>([
	{
		id: 'temp',
		label: m["settings.deviceHealth.lane.temp"](),
		samples: tempSamples,
		domain: TEMP_DOMAIN,
		gapMs: TEMP_GAP_MS,
		bucketMs: TEMP_BUCKET_MS,
		degraded: tempStatus.state === 'aging' || tempStatus.state === 'unavailable',
		formatScale: formatTempScale,
	},
	{
		id: 'load',
		label: m["settings.deviceHealth.lane.load"](),
		samples: loadSamples,
		domain: 'auto',
		autoMinCeiling: LOAD_DOMAIN_MIN_CEILING,
		gapMs: LOAD_GAP_MS,
		degraded: loadStatus.state === 'aging' || loadStatus.state === 'unavailable',
		formatScale: formatLoadScale,
	},
	// Memory is the ONLY new trace: it is a share of a denominator the device
	// itself published, so it plots against a fixed scale with no disclosure
	// needed. GPU and DDR load are readouts in the band below instead — they are
	// hardware-gated on the vendor kernel and absent on mainline, and a lane that
	// is empty on half the fleet is a worse instrument than a row that simply
	// does not appear. Promoting either to a lane is a follow-up, not this pass.
	{
		id: 'memory',
		label: m["settings.deviceHealth.lane.memory"](),
		samples: memorySamples,
		domain: MEMORY_DOMAIN,
		gapMs: MEMORY_GAP_MS,
		degraded: memoryStatus.state === 'aging' || memoryStatus.state === 'unavailable',
		formatScale: formatPercentScale,
	},
]);

// ABSENT is never 0 % and never "idle": a mainline kernel publishes no DDR
// devfreq device and may publish no GPU load interface at all, so a missing key
// means "this kernel does not report it". The two are INDEPENDENT probes — one
// can answer while the other does not — so each row is gated on its own key.
const deviceStats = $derived(getDeviceStats());
const gpu = $derived(deviceStats?.gpu);
const ddr = $derived(deviceStats?.ddr);

// The kbase path structurally cannot report a frequency, so a GPU load with no
// frequency beside it is an ordinary reading — never draw "0 Hz" for it.
const gpuDetail = $derived.by(() => {
	const cur = gpu?.curFreqHz;
	const max = gpu?.maxFreqHz;
	if (cur !== undefined && max !== undefined) return `${formatHz(cur)} / ${formatHz(max)}`;
	if (cur !== undefined) return formatHz(cur);
	if (max !== undefined) return formatHz(max);
	return null;
});
const ddrDetail = $derived(
	ddr === undefined ? null : `${formatHz(ddr.curFreqHz)} / ${formatHz(ddr.maxFreqHz)}`,
);

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
	if (caps?.engineUnavailable === true) return m["settings.deviceHealth.encoder.engineUnavailable"]();
	if (caps?.engineStarting === true) return m["settings.deviceHealth.encoder.engineStarting"]();
	if (activeEncode === undefined || activeEncode === null) return m["settings.deviceHealth.encoder.idle"]();
	const framerate = Number.isFinite(activeEncode.framerate) ? `${activeEncode.framerate}` : '';
	const summary = [activeEncode.codec, activeEncode.resolution, framerate]
		.filter((part) => part.length > 0)
		.join(' ');
	return m["settings.deviceHealth.encoder.active"]({ summary });
});

// `advancing === false` is the ONLY stall claim; `null` is the cold-start /
// idle-window branch and must never read as "stalled".
const framesVerdict = $derived.by(() => {
	const advancing = rollup?.frames.advancing;
	if (advancing === true) return m["settings.deviceHealth.encoder.framesAdvancing"]();
	if (advancing === false) return m["settings.deviceHealth.encoder.framesStalled"]();
	return m["settings.deviceHealth.encoder.framesUnknown"]();
});

const hardware = $derived(getSources()?.hardware);
const soc = $derived(getSocTelemetry());
const powerRails = $derived.by(() => {
	if (hardware === 'rk3588' || hardware === 'n100') {
		return { kind: 'not-instrumented' as const, text: m["settings.deviceHealth.power.notInstrumented"]() };
	}
	if (hardware === 'jetson' && (soc.voltage !== null || soc.current !== null)) {
		const parts = [
			soc.voltage === null ? null : `${soc.voltage.toFixed(2)} V`,
			soc.current === null ? null : `${soc.current.toFixed(2)} A`,
		].filter((part): part is string => part !== null);
		return { kind: 'live' as const, text: parts.join('  ') };
	}
	return { kind: 'no-reading' as const, text: m["settings.deviceHealth.power.noReading"]() };
});

const traceSummary = $derived.by(() => {
	const parts: string[] = [];
	if (tempStats !== null) {
		parts.push(
			`${m["settings.deviceHealth.lane.temp"]()} ${formatTemp(tempStats.last)} (${formatTemp(tempStats.min)} – ${formatTemp(tempStats.max)})`,
		);
	}
	if (loadStats !== null) {
		parts.push(
			`${m["settings.deviceHealth.nowStrip.load"]()} ${formatLoad(loadStats.last)} (${formatLoad(loadStats.min)} – ${formatLoad(loadStats.max)})`,
		);
	}
	if (memoryStats !== null) {
		parts.push(
			`${m["settings.deviceHealth.lane.memory"]()} ${formatPercent(memoryStats.last)} (${formatPercent(memoryStats.min)} – ${formatPercent(memoryStats.max)})`,
		);
	}
	return parts.length === 0 ? m["settings.deviceHealth.waiting"]() : parts.join(' \u00b7 ');
});

// The widget's headline is real text, not colour, and it belongs in the panel's
// EXISTING polite region rather than a second one competing with it.
const encoderHeadline = $derived.by(() => {
	const activity = deriveEncoderActivity(encoderLoad);
	if (activity === 'encoding') return m["settings.deviceHealth.cores.headlineEncoding"]();
	if (activity === 'idle') return m["settings.deviceHealth.cores.headlineIdle"]();
	return m["settings.deviceHealth.cores.headlineUnreported"]();
});

const announcement = $derived(
	[
		tempStatus.value === null ? null : formatTemp(tempStatus.value),
		loadStatus.value === null ? null : formatLoad(loadStatus.value),
		encoderCondition,
		`${m["settings.deviceHealth.cores.title"]()} ${encoderHeadline}`,
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

<!-- Metadata ABOUT the cores, not a fact of its own. As a bare figure pinned to
     the header's far right it read as an orphaned number; naming and enclosing
     it demotes it to the provenance chip it is. -->
{#snippet engineRevisionChip()}
	{#if engineRevision}
		<span
			class="border-border/60 bg-muted/40 ms-auto inline-flex min-w-0 shrink items-baseline gap-1.5 rounded-full border px-2 py-0.5"
			data-testid="device-health-engine-revision"
		>
			<span class="text-muted-foreground/70 shrink-0 text-[0.625rem] font-medium tracking-wide">
				{m["settings.deviceHealth.cores.engineLabel"]()}
			</span>
			<span class="text-muted-foreground min-w-0 truncate font-mono text-[11px] tabular-nums">
				{engineRevision}
			</span>
		</span>
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
				title={m["settings.deviceHealth.unavailable"]()}
				aria-label={m["settings.deviceHealth.unavailable"]()}
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

<!-- One dense LINE, not a stacked cell, and no proportional rail.
     The Device Health panel is forbidden to scroll on the 1024x600 kiosk (C5,
     pinned by device-telemetry-v2.visual.spec.ts) and measured at EXACTLY its
     box height before this change, so every pixel these readouts cost had to be
     found elsewhere in the panel. A stacked cell in the now strip was tried and
     measured: five columns at 1024px wrap the wordier cells and cost ~40px more
     than they save. A rail would also have been a lie of emphasis — these are
     supporting readings beside three traced channels, not a fourth trace. -->
{#snippet loadReadout(
	label: string,
	icon: typeof Gauge,
	percent: number,
	detail: string | null,
	testId: string,
)}
	{@const Icon = icon}
	<span class="flex min-w-0 items-baseline gap-1.5" data-testid={testId}>
		<Icon aria-hidden={true} class="size-3.5 shrink-0 self-center" />
		<span class="shrink-0">{label}</span>
		<span
			class="text-foreground font-mono tabular-nums"
			data-testid="{testId}-value"
		>
			{formatPercent(percent)}
		</span>
		{#if detail !== null}
			<span
				class="text-muted-foreground/70 min-w-0 truncate font-mono text-[11px] tabular-nums"
				data-testid="{testId}-detail"
			>
				{detail}
			</span>
		{/if}
	</span>
{/snippet}

<div class={cn(isCompact.current ? 'space-y-2' : 'space-y-4')} data-testid="device-health">
	<!-- Band 1 — the now strip. Always mounted: "no strip" must never be
	     confusable with "no data". It is also the accessible primary, so a
	     screen-reader user gets the same facts without the trace. -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="device-health-now">
		{@render fact(
			m["settings.deviceHealth.nowStrip.temperature"](),
			Thermometer,
			tempStatus,
			formatTemp,
			tempStats === null ? null : m["settings.deviceHealth.delta"]({ value: formatSigned(tempStats.delta, 1) }),
			'health-fact-temp',
		)}
		{@render fact(
			m["settings.deviceHealth.nowStrip.load"](),
			Cpu,
			loadStatus,
			formatLoad,
			loadStats === null ? null : m["settings.deviceHealth.peak"]({ value: formatLoad(loadStats.max) }),
			'health-fact-load',
		)}
		<div class="col-span-2 min-w-0 space-y-1 sm:col-span-1" data-testid="health-fact-encoder">
			<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
				<Activity aria-hidden={true} class="size-3.5 shrink-0" />
				<span class="truncate">{m["settings.deviceHealth.nowStrip.encoder"]()}</span>
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
		ariaLabel={m["settings.deviceHealth.traceLabel"]({ summary: traceSummary })}
		axisMinutesAgo={(minutes) => m["settings.deviceHealth.axis.minutesAgo"]({ n: minutes })}
		axisNowLabel={m["settings.deviceHealth.axis.now"]()}
		compact={isCompact.current}
		{frozen}
		gapLabel={m["settings.deviceHealth.gap"]()}
		{lanes}
		{now}
		waitingLabel={m["settings.deviceHealth.waiting"]()}
	/>

	<!-- Band 3 — the unified encoder widget. Its own header replaces this band's
	     former <h3>, so the word "Encoder" is printed once rather than twice. -->
	<section data-testid="device-health-encoder">
		<EncoderStatus
			compact={isCompact.current}
			density="panel"
			headerAside={engineRevisionChip}
			reading={encoderLoad}
			showDecoders={true}
		/>
	</section>

	<!-- Band 4 — GPU and DDR load. Readouts, never lanes: both are vendor-kernel
	     signals that are simply ABSENT on mainline, and the whole row disappears
	     rather than drawing a permanently-empty trace. Each readout is gated on
	     its OWN key — the two are independent probes, so a board can answer one
	     and not the other, and a missing key means "this kernel does not report
	     it", never 0 % and never idle. -->
	{#if gpu !== undefined || ddr !== undefined}
		<section
			class="text-muted-foreground flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t pt-3 text-xs"
			data-testid="device-health-loads"
		>
			{#if gpu !== undefined}
				{@render loadReadout(m["settings.deviceHealth.loads.gpu"](), Gauge, gpu.loadPercent, gpuDetail, 'health-load-gpu')}
			{/if}
			{#if ddr !== undefined}
				{@render loadReadout(
					m["settings.deviceHealth.loads.ddr"](),
					MemoryStick,
					ddr.loadPercent,
					ddrDetail,
					'health-load-ddr',
				)}
			{/if}
		</section>
	{/if}

	<!-- Band 5 — power rails: a provable statement, never an em-dash. The compact
	     profile prints it on ONE line: the kiosk pays for the memory channel and
	     these readouts out of exactly this kind of slack, and a two-line label +
	     value stack says nothing a single line does not. -->
	<section
		class={cn('flex gap-2.5 border-t', isCompact.current ? 'items-baseline pt-3' : 'items-start pt-4')}
		data-testid="device-health-power"
		data-power-state={powerRails.kind}
	>
		<Zap
			aria-hidden={true}
			class={cn(
				'text-muted-foreground size-3.5 shrink-0 self-center',
				!isCompact.current && 'mt-0.5 self-start',
			)}
		/>
		<div
			class={cn(
				'min-w-0',
				isCompact.current ? 'flex flex-wrap items-baseline gap-x-2' : 'space-y-0.5',
			)}
		>
			<span class="block text-xs font-medium">{m["settings.deviceHealth.power.title"]()}</span>
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
