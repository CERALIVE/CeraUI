<!--
  DeviceStatsSection.svelte — device telemetry as a glance grid, not a list.

  It was a flat `divide-y` list mapped 1:1 from a local `Row[]`: every signal
  cost a full row of vertical height, every signal was weighted the same, and
  the only way to add one was to make the panel taller. On the 1024x600 kiosk
  touchscreen that is a scroll, and it also pushed any new signal toward the
  S1-locked `device-stats` payload just to avoid the height.

  Two tiers share one container, driven by `device-stats-model.ts`:

    primary   — a glance grid of compact tiles. It grows SIDEWAYS then wraps,
                so a new signal costs width, not height.
    secondary — denser rows beneath the grid, for provenance facts that rarely
                change or that a richer surface elsewhere already owns.

  NOTHING HERE IS BEHIND A CLICK. The secondary tier was briefly a collapsed
  <details> disclosure; operator feedback on the deployed board was that hiding
  telemetry behind an expander is the wrong trade on a device whose whole job is
  reporting its own condition. So the disclosure is gone and the tier pays for
  itself with a DENSER row instead — an icon-and-label line rather than the old
  36px avatar row. Cheaper than the disclosure it replaced, and always readable.

  MULTI-SOURCE BY DESIGN. `device-stats` keeps five ALWAYS-PRESENT signals (the
  S1 lock) and carries the later collector signals — memory, per-policy CPU
  frequency, DDR and GPU — as OPTIONAL keys beside them; the fan and the encoder
  arrive on their OWN broadcasts. This container reads all three and is agnostic
  to how many feed it.

  AN OPTIONAL SIGNAL THAT DID NOT ARRIVE HAS NO TILE. That is a different rule
  from the placeholder below, and the difference is the point. An absent key
  means the kernel publishes no such interface — this board cannot answer — so
  there is nothing to label. A `null` value means the signal EXISTS and this
  sample had no figure, which is worth a line. Rendering the first as the second
  would invite an operator to wait for a reading that is never coming.

  AND NOTHING IS A BARE MARK. A signal with no reading says so in WORDS. The
  em-dash this used to render was a glyph an operator had to decode, and the word
  it stood for was hidden in a `title` that a touchscreen cannot hover to reveal —
  so saying it out loud only surfaces what was already there. The fan's `absent`
  state is the same principle one step further: "No fan" is a provable statement
  about the board, and hiding the tile would make it indistinguishable from "this
  build has no fan feature".
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import {
	Activity,
	ArrowDownUp,
	CircuitBoard,
	Cpu,
	Fan,
	Gauge,
	HardDrive,
	Layers,
	MemoryStick,
	Microchip,
	Replace,
	Thermometer,
} from '@lucide/svelte';

import EncoderStatus from '$lib/components/custom/EncoderStatus.svelte';
import { getCpuInfo, getDeviceStats, getFanSnapshot } from '$lib/rpc/subscriptions.svelte';
import { getEncoderLoad } from '$lib/stores/device-health-history.svelte';
import { type CpuFreqRow, cpuFreqBar, deriveCpuFreqRows } from '$lib/system/cpu-freq';
import { type CpuLoadBand, deriveCpuLoad } from '$lib/system/cpu-load';
import { deriveFanState, fanDutyFraction } from '$lib/system/fan-status';
import { cn } from '$lib/utils';

import {
	type DeviceStatBarTone,
	type DeviceStatSignal,
	partitionSignals,
} from './device-stats-model';

// The encoder's label already exists, translated, one namespace over. A second
// key for the identical word is copy sprawl, not clarity.
const encoderLabel = $derived(m["settings.deviceHealth.nowStrip.encoder"]());

// Sentinel the backend emits for the boot slot when `rauc` is absent.
const RAUC_UNAVAILABLE = 'unavailable';

const BAR_TONE: Record<DeviceStatBarTone, string> = {
	primary: 'bg-primary',
	warning: 'bg-status-warning',
	critical: 'bg-destructive',
};

// Humanize a byte count to a decimal-SI string ("58.2 GB"). Sub-KB stays whole.
function humanBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = n;
	let i = 0;
	while (value >= 1000 && i < units.length - 1) {
		value /= 1000;
		i++;
	}
	return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Humanize a byte/second rate to a decimal-SI string ("2.1 MB/s").
function humanRate(n: number): string {
	const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
	let value = n;
	let i = 0;
	while (value >= 1000 && i < units.length - 1) {
		value /= 1000;
		i++;
	}
	return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Binary GiB, one decimal — the scale `/proc/meminfo` is actually reported in
// (its "kB" is KiB). `humanBytes` above stays decimal-SI because a disk is SOLD
// in decimal gigabytes; showing RAM on that scale would misstate every figure by
// 7 % against every other tool on the box.
function gibibytes(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

// TWO frequency formatters, each naming the unit it CONSUMES, because this one
// payload carries both: cpufreq reports kHz and devfreq reports Hz. A single
// shared helper would be a silent 1000x error the types cannot catch.
function ghzFromKhz(khz: number): string {
	return `${(khz / 1_000_000).toFixed(2)} GHz`;
}

function mhzFromHz(hz: number): string {
	return `${Math.round(hz / 1_000_000)} MHz`;
}

function wholePercent(value: number): string {
	return `${Math.round(value)} %`;
}

const stats = $derived(getDeviceStats());
const fan = $derived(getFanSnapshot());
const cpu = $derived(getCpuInfo());
// The SAME read path the Live cockpit and the Device Health panel use — it
// prefers the device's `encoder-load` broadcast and falls back to the dev-only
// `?health-mock=` fixture. No second subscription, no second precedence rule.
const encoderLoad = $derived(getEncoderLoad());

const fanSignal = $derived.by<DeviceStatSignal>(() => {
	const state = deriveFanState(fan);
	const fraction = fanDutyFraction(fan);
	const base = {
		key: 'fan',
		icon: Fan,
		label: m["settings.deviceStats.fan"](),
		tier: 'primary' as const,
		attrs: { 'data-fan-state': state },
	};
	if (state === 'absent') {
		return { ...base, value: m["settings.deviceStats.fanAbsent"](), sub: m["settings.deviceStats.fanAbsentBody"](), prose: true };
	}
	if (state === 'unknown' || fraction === null) return { ...base, value: null };
	return {
		...base,
		value: `${Math.round(fraction * 100)} %`,
		fraction,
		sub: state === 'running' ? m["settings.deviceStats.fanCooling"]() : m["settings.deviceStats.fanOff"](),
		hint: m["settings.deviceStats.fanHint"](),
	};
});

// Colour REINFORCES the band word; it never carries it alone.
const CPU_BAND_TONE: Record<CpuLoadBand, DeviceStatBarTone> = {
	light: 'primary',
	moderate: 'warning',
	heavy: 'critical',
};

const cpuLoadSignal = $derived.by<DeviceStatSignal>(() => {
	const base = {
		key: 'cpuLoad',
		icon: Cpu,
		label: m["settings.deviceStats.cpuLoad"](),
		tier: 'primary' as const,
	};
	const reading = deriveCpuLoad(stats?.cpuLoad1, cpu?.cores);
	if (reading === null) return { ...base, value: null };

	const load = reading.load1.toFixed(2);
	const cores = reading.cores;
	// No core count on the wire ⇒ no honest denominator, so the raw load average
	// stays the headline rather than being divided by an assumed one.
	if (reading.percent === null || reading.fraction === null || cores === null) {
		return { ...base, value: load, hint: m["settings.deviceStats.cpuLoadHintNoCores"]() };
	}
	const band = reading.band ?? 'light';
	const bandLabel = {
		light: m["settings.deviceStats.cpuLoadLight"](),
		moderate: m["settings.deviceStats.cpuLoadModerate"](),
		heavy: m["settings.deviceStats.cpuLoadHeavy"](),
	}[band];
	return {
		...base,
		value: `${reading.percent} %`,
		fraction: reading.fraction,
		barTone: CPU_BAND_TONE[band],
		sub: `${bandLabel} \u00b7 ${m["settings.deviceStats.cpuLoadRaw"]({ load })}`,
		hint: m["settings.deviceStats.cpuLoadHint"]({ cores }),
		attrs: { 'data-cpu-band': band },
	};
});

// Every one of the four below answers `null` for "this board publishes no such
// interface", and a `null` is dropped from the array rather than tiled.

const memorySignal = $derived.by<DeviceStatSignal | null>(() => {
	const total = stats?.memTotalBytes;
	const available = stats?.memAvailableBytes;
	const percent = stats?.memUsedPercent;
	if (total === undefined && available === undefined && percent === undefined) {
		return null;
	}
	const used = total !== undefined && available !== undefined ? total - available : undefined;
	return {
		key: 'memory',
		icon: MemoryStick,
		label: m["settings.deviceStats.memory"](),
		tier: 'primary',
		value:
			percent !== undefined
				? wholePercent(percent)
				: used !== undefined
					? gibibytes(used)
					: null,
		...(used !== undefined && total !== undefined
			? { sub: `${gibibytes(used)} / ${gibibytes(total)}` }
			: total !== undefined
				? { sub: gibibytes(total) }
				: {}),
		// The percent is the ONLY honest denominator here: it is derived against
		// MemAvailable, so page cache does not read as consumed.
		...(percent !== undefined ? { fraction: percent / 100 } : {}),
		hint: m["settings.deviceStats.memoryHint"](),
	};
});

const swapSignal = $derived.by<DeviceStatSignal | null>(() => {
	const total = stats?.swapTotalBytes;
	if (total === undefined) return null;
	const free = stats?.swapFreeBytes;
	const used = free !== undefined ? total - free : undefined;
	return {
		key: 'swap',
		icon: Replace,
		label: m["settings.deviceStats.swap"](),
		tier: 'secondary',
		// A measured `SwapTotal: 0` is the board ANSWERING "none". Printing it as
		// "0.0 GiB / 0.0 GiB" would dress a plain fact up as a reading at zero.
		value:
			total === 0
				? m["settings.deviceStats.swapNone"]()
				: used !== undefined
					? `${gibibytes(used)} / ${gibibytes(total)}`
					: gibibytes(total),
	};
});

const cpuFreqView = $derived(deriveCpuFreqRows(stats?.cpuFreq));

// A folded group has no single current clock, so its reading is the RANGE its
// members occupy. Collapsing that to one figure would pick a core to be about.
function cpuFreqReading(row: CpuFreqRow): string {
	const current =
		row.curMinKhz === row.curMaxKhz
			? ghzFromKhz(row.curMaxKhz)
			: `${(row.curMinKhz / 1_000_000).toFixed(2)}\u2013${ghzFromKhz(row.curMaxKhz)}`;
	return `${current} / ${ghzFromKhz(row.maxKhz)}`;
}

// The sysfs id stays visible where it names exactly ONE thing. A folded group
// spans several policies, so naming its first one would be a wrong label rather
// than a diagnostic.
function cpuFreqDetail(row: CpuFreqRow): string | undefined {
	const parts: string[] = [];
	if (row.named && row.policyIds.length === 1 && row.policyIds[0] !== undefined) {
		parts.push(row.policyIds[0]);
	}
	if (row.cpus !== undefined) parts.push(`cpu${row.cpus}`);
	return parts.length > 0 ? parts.join(' \u00b7 ') : undefined;
}

const cpuFreqSignal = $derived.by<DeviceStatSignal | null>(() => {
	if (cpuFreqView.rows.length === 0) return null;
	return {
		key: 'cpuFreq',
		icon: Gauge,
		label: m["settings.deviceStats.cpuFreq"](),
		// No `value`: the board runs SEVERAL policies at different clocks, and any
		// single string would either pick a winner or average incomparable
		// clusters — the same reason the encoder renders its own body.
		value: null,
		body: cpuFreqBody,
		fullWidth: true,
		tier: 'primary',
	};
});

const ddrSignal = $derived.by<DeviceStatSignal | null>(() => {
	const ddr = stats?.ddr;
	if (!ddr) return null;
	return {
		key: 'ddr',
		icon: Layers,
		label: m["settings.deviceStats.ddr"](),
		value: wholePercent(ddr.loadPercent),
		fraction: ddr.loadPercent / 100,
		sub: `${mhzFromHz(ddr.curFreqHz)} / ${mhzFromHz(ddr.maxFreqHz)}`,
		hint: m["settings.deviceStats.ddrHint"](),
		tier: 'primary',
	};
});

const gpuSignal = $derived.by<DeviceStatSignal | null>(() => {
	const gpu = stats?.gpu;
	if (!gpu) return null;
	// The Mali kbase node structurally cannot report a clock, so a load with no
	// frequency beside it is an ORDINARY reading — not a partial one. Printing
	// "0 MHz" there would invent a measurement the interface cannot make.
	const cur = gpu.curFreqHz;
	const max = gpu.maxFreqHz;
	const sub =
		cur !== undefined && max !== undefined
			? `${mhzFromHz(cur)} / ${mhzFromHz(max)}`
			: cur !== undefined
				? mhzFromHz(cur)
				: undefined;
	return {
		key: 'gpu',
		icon: Microchip,
		label: m["settings.deviceStats.gpu"](),
		value: wholePercent(gpu.loadPercent),
		fraction: gpu.loadPercent / 100,
		...(sub !== undefined ? { sub } : {}),
		hint: m["settings.deviceStats.gpuHint"](),
		tier: 'primary',
	};
});

const signals = $derived.by<DeviceStatSignal[]>(() => {
	const s = stats;
	const disk = s?.disk ?? null;
	const net = s?.ifaceRxTx ?? null;
	const slot = s?.raucSlot;

	const declared: (DeviceStatSignal | null)[] = [
		{
			key: 'socTemp',
			icon: Thermometer,
			label: m["settings.deviceStats.socTemp"](),
			// No bar: a temperature has no 0-100 denominator to draw against.
			value: s && s.socTemp != null ? `${s.socTemp.toFixed(1)} \u00b0C` : null,
			tier: 'primary',
		},
		cpuLoadSignal,
		memorySignal,
		fanSignal,
		{
			key: 'disk',
			icon: HardDrive,
			label: m["settings.deviceStats.disk"](),
			sub: disk
				? disk.type !== 'unknown'
					? `${humanBytes(disk.total)} \u00b7 ${disk.type}`
					: humanBytes(disk.total)
				: undefined,
			value: disk ? humanBytes(disk.used) : null,
			...(disk && disk.total > 0 ? { fraction: disk.used / disk.total } : {}),
			tier: 'primary',
		},
		gpuSignal,
		ddrSignal,
		// The two full-width bands close the primary tier, so the scalar tiles
		// above them keep filling clean rows rather than being split around a
		// band that spans the whole grid.
		cpuFreqSignal,
		{
			key: 'encoder',
			icon: Activity,
			label: encoderLabel,
			// LAST in the primary order, and full width. No `value`: the encoding
			// silicon is TWO cores whose readings are incomparable, so no single
			// string tells the truth about it — it renders its own widget instead.
			value: null,
			body: encoderBody,
			fullWidth: true,
			tier: 'primary',
		},
		swapSignal,
		{
			key: 'network',
			icon: ArrowDownUp,
			label: m["settings.deviceStats.network"](),
			sub: net?.iface,
			value: net
				? `\u2191 ${humanRate(net.txBytesPerSec)}  \u2193 ${humanRate(net.rxBytesPerSec)}`
				: null,
			// Demoted: a coarse one-interface summary of what Network →
			// BondedLinksSection owns properly. Kept, because it is a different
			// quantity (kernel counters), just not a glance fact.
			tier: 'secondary',
		},
		{
			key: 'bootSlot',
			icon: CircuitBoard,
			label: m["settings.deviceStats.bootSlot"](),
			// Changes only across an OTA.
			value: slot && slot !== RAUC_UNAVAILABLE ? slot : null,
			tier: 'secondary',
		},
	];

	return declared.filter((signal): signal is DeviceStatSignal => signal !== null);
});

const tiers = $derived(partitionSignals(signals));
</script>

{#snippet encoderBody()}
	<EncoderStatus compact={true} density="inline" reading={encoderLoad} />
{/snippet}

<!-- Rows come from `deriveCpuFreqRows`, which reports which SHAPE it folded (see
     `$lib/system/cpu-freq`). A row is named by the device's own label or by the
     sysfs id, never by list position and never by a board model — so RK3588's
     `policy0` reads "Cortex-A55 x4" only because /proc/cpuinfo said so, and a
     device that sent no metadata still renders exactly `policy0`.

     The bar's denominator is `maxKhz` — `cpuinfo_max_freq`, the hardware ceiling
     — so it does not wander when the governor moves. -->
{#snippet cpuFreqBody()}
	<div
		class="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3"
		data-cpufreq-shape={cpuFreqView.shape}
		data-testid="cpufreq-policies"
		title={m["settings.deviceStats.cpuFreqHint"]()}
	>
		{#each cpuFreqView.rows as row (row.key)}
			{@const bar = cpuFreqBar(row)}
			{@const detail = cpuFreqDetail(row)}
			<div
				class="min-w-0 space-y-1"
				data-policy-count={row.policyIds.length}
				data-testid={`cpufreq-policy-${row.key}`}
			>
				<span class="flex items-baseline justify-between gap-2 text-xs">
					<span class="flex min-w-0 items-baseline gap-1.5">
						<span class="text-muted-foreground truncate">
							{row.name}{#if row.named && row.cpuCount !== undefined}&nbsp;&times;{row.cpuCount}{/if}
						</span>
						{#if row.governor}
							<span
								class="bg-secondary text-muted-foreground shrink-0 rounded px-1 py-px font-mono text-[10px] leading-tight"
								data-testid={`cpufreq-policy-governor-${row.key}`}
								title={m["settings.deviceStats.cpuFreqGovernorHint"]()}
							>{row.governor}</span>
						{/if}
					</span>
					<span
						class="text-foreground shrink-0 font-mono tabular-nums"
						data-testid={`cpufreq-policy-value-${row.key}`}
					>{cpuFreqReading(row)}</span>
				</span>
				{#if bar}
					<span
						aria-hidden="true"
						class="bg-secondary relative block h-1 w-full overflow-hidden rounded-full"
						data-bar-kind={bar.kind}
						data-testid={`cpufreq-policy-bar-${row.key}`}
					>
						<span
							class="bg-primary absolute inset-y-0 rounded-full"
							style="inset-inline-start: {bar.startPercent}%; inline-size: {bar.sizePercent}%"
						></span>
					</span>
				{/if}
				{#if detail}
					<span
						class="text-muted-foreground/70 block truncate font-mono text-[10px]"
						data-testid={`cpufreq-policy-detail-${row.key}`}
					>{detail}</span>
				{/if}
			</div>
		{/each}
	</div>
{/snippet}

{#snippet placeholder(key: string, sizeClass: string)}
	<span
		class={cn('text-muted-foreground/70 font-medium', sizeClass)}
		data-testid={`device-stat-${key}-value`}
	>
		{m["settings.deviceStats.unavailable"]()}
	</span>
{/snippet}

<section class="space-y-2.5" data-testid="device-stats">
	<h2 class="text-muted-foreground px-1 text-sm font-medium">{m["settings.deviceStats.title"]()}</h2>
	<div class="bg-card overflow-hidden rounded-xl border">
		<!-- Tier 1 — the glance grid. Mirrors the Device Health now-strip's
		     `grid-cols-2 sm:grid-cols-3` rhythm so the two telemetry surfaces read
		     as one system, and wraps instead of clipping at 1024px. -->
		<div class="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
			{#each tiers.primary as signal (signal.key)}
				{@const TileIcon = signal.icon}
				<div
					class={cn(
						'min-w-0 space-y-1',
						signal.fullWidth && 'col-span-2 sm:col-span-3 lg:col-span-4',
					)}
					data-testid={`device-stat-${signal.key}`}
					data-tier="primary"
					{...signal.attrs ?? {}}
				>
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<TileIcon aria-hidden={true} class="size-3.5 shrink-0" />
						<span class="truncate">{signal.label}</span>
					</span>
					{#if signal.body}
						{@render signal.body()}
					{:else if signal.value === null}
						<!-- Legible, but deliberately one step quieter than a real figure:
						     "no reading" is information, not a headline. -->
						{@render placeholder(signal.key, 'block text-sm')}
					{:else}
						<span
							class={cn(
								'text-foreground block truncate text-base font-semibold',
								signal.prose ? '' : 'font-mono tabular-nums',
							)}
							data-testid={`device-stat-${signal.key}-value`}
							title={signal.hint}
						>
							{signal.value}
						</span>
					{/if}
					{#if signal.fraction !== undefined}
						<span
							aria-hidden="true"
							class="bg-secondary relative block h-1.5 w-full overflow-hidden rounded-full"
							data-bar-tone={signal.barTone ?? 'primary'}
							data-testid={`device-stat-${signal.key}-bar`}
						>
							<span
								class={cn('absolute inset-y-0 start-0 rounded-full', BAR_TONE[signal.barTone ?? 'primary'])}
								style="inline-size: {Math.min(100, Math.max(0, signal.fraction * 100))}%"
							></span>
						</span>
					{/if}
					{#if signal.sub}
						<span class="text-muted-foreground block text-[11px] leading-snug">{signal.sub}</span>
					{/if}
				</div>
			{/each}
		</div>

		{#if tiers.secondary.length > 0}
			<!-- Tier 2 — ALWAYS VISIBLE. It earns its place by being dense (an
			     icon-and-label line, not the old 36px avatar row), not by hiding. -->
			<div class="divide-border divide-y border-t" data-testid="device-stats-secondary">
				{#each tiers.secondary as signal (signal.key)}
					{@const RowIcon = signal.icon}
					<div
						class="flex w-full items-baseline gap-2 px-4 py-2"
						data-testid={`device-stat-${signal.key}`}
						data-tier="secondary"
						{...signal.attrs ?? {}}
					>
						<RowIcon aria-hidden={true} class="text-muted-foreground size-3.5 shrink-0" />
						<span class="text-muted-foreground shrink-0 text-xs">{signal.label}</span>
						{#if signal.sub}
							<span class="text-muted-foreground/70 min-w-0 truncate text-[11px]">{signal.sub}</span>
						{/if}
						{#if signal.value === null}
							{@render placeholder(signal.key, 'ms-auto shrink-0 text-xs')}
						{:else}
							<span
								class="text-foreground ms-auto shrink-0 font-mono text-xs tabular-nums"
								data-testid={`device-stat-${signal.key}-value`}
							>
								{signal.value}
							</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
