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

  MULTI-SOURCE BY DESIGN. `device-stats` is frozen at five signals (S1 lock), so
  the fan and the encoder arrive on their OWN broadcasts. This container reads
  all three and is agnostic to how many feed it.

  AND NOTHING IS A BARE MARK. A signal with no reading says so in WORDS. The
  em-dash this used to render was a glyph an operator had to decode, and the word
  it stood for was hidden in a `title` that a touchscreen cannot hover to reveal —
  so saying it out loud only surfaces what was already there. The fan's `absent`
  state is the same principle one step further: "No fan" is a provable statement
  about the board, and hiding the tile would make it indistinguishable from "this
  build has no fan feature".
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	Activity,
	ArrowDownUp,
	CircuitBoard,
	Cpu,
	Fan,
	HardDrive,
	Thermometer,
} from '@lucide/svelte';

import EncoderStatus from '$lib/components/custom/EncoderStatus.svelte';
import { getDeviceStats, getFanSnapshot } from '$lib/rpc/subscriptions.svelte';
import { getEncoderLoad } from '$lib/stores/device-health-history.svelte';
import { deriveFanState, fanDutyFraction } from '$lib/system/fan-status';
import { cn } from '$lib/utils';

import { type DeviceStatSignal, partitionSignals } from './device-stats-model';

const t = $derived($LL.settings.deviceStats);
// The encoder's label already exists, translated, one namespace over. A second
// key for the identical word is copy sprawl, not clarity.
const encoderLabel = $derived($LL.settings.deviceHealth.nowStrip.encoder());

// Sentinel the backend emits for the boot slot when `rauc` is absent.
const RAUC_UNAVAILABLE = 'unavailable';

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

const stats = $derived(getDeviceStats());
const fan = $derived(getFanSnapshot());
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
		label: t.fan(),
		tier: 'primary' as const,
		attrs: { 'data-fan-state': state },
	};
	if (state === 'absent') {
		return { ...base, value: t.fanAbsent(), sub: t.fanAbsentBody(), prose: true };
	}
	if (state === 'unknown' || fraction === null) return { ...base, value: null };
	return {
		...base,
		value: `${Math.round(fraction * 100)} %`,
		fraction,
		sub: state === 'running' ? t.fanCooling() : t.fanOff(),
	};
});

const signals = $derived.by<DeviceStatSignal[]>(() => {
	const s = stats;
	const disk = s?.disk ?? null;
	const net = s?.ifaceRxTx ?? null;
	const slot = s?.raucSlot;

	return [
		{
			key: 'socTemp',
			icon: Thermometer,
			label: t.socTemp(),
			// No bar: a temperature has no 0-100 denominator to draw against.
			value: s && s.socTemp != null ? `${s.socTemp.toFixed(1)} \u00b0C` : null,
			tier: 'primary',
		},
		{
			key: 'cpuLoad',
			icon: Cpu,
			label: t.cpuLoad(),
			// No bar: converting a load average needs the device's core count,
			// which the frontend does not have.
			value: s && s.cpuLoad1 != null ? s.cpuLoad1.toFixed(2) : null,
			tier: 'primary',
		},
		fanSignal,
		{
			key: 'disk',
			icon: HardDrive,
			label: t.disk(),
			sub: disk
				? disk.type !== 'unknown'
					? `${humanBytes(disk.total)} \u00b7 ${disk.type}`
					: humanBytes(disk.total)
				: undefined,
			value: disk ? humanBytes(disk.used) : null,
			...(disk && disk.total > 0 ? { fraction: disk.used / disk.total } : {}),
			tier: 'primary',
		},
		{
			key: 'encoder',
			icon: Activity,
			label: encoderLabel,
			// LAST in the primary order, and full width. No `value`: the encoding
			// silicon is TWO cores whose readings are incomparable, so no single
			// string tells the truth about it — it renders its own widget instead.
			// Placing it last lets the four scalar tiles fill a clean row above it
			// rather than being split around a band that spans the whole grid.
			value: null,
			body: encoderBody,
			fullWidth: true,
			tier: 'primary',
		},
		{
			key: 'network',
			icon: ArrowDownUp,
			label: t.network(),
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
			label: t.bootSlot(),
			// Changes only across an OTA.
			value: slot && slot !== RAUC_UNAVAILABLE ? slot : null,
			tier: 'secondary',
		},
	];
});

const tiers = $derived(partitionSignals(signals));
</script>

{#snippet encoderBody()}
	<EncoderStatus compact={true} density="inline" reading={encoderLoad} />
{/snippet}

{#snippet placeholder(key: string, sizeClass: string)}
	<span
		class={cn('text-muted-foreground/70 font-medium', sizeClass)}
		data-testid={`device-stat-${key}-value`}
	>
		{t.unavailable()}
	</span>
{/snippet}

<section class="space-y-2.5" data-testid="device-stats">
	<h2 class="text-muted-foreground px-1 text-sm font-medium">{t.title()}</h2>
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
							title={signal.key === 'fan' ? t.fanHint() : undefined}
						>
							{signal.value}
						</span>
					{/if}
					{#if signal.fraction !== undefined}
						<span
							aria-hidden="true"
							class="bg-secondary relative block h-1.5 w-full overflow-hidden rounded-full"
							data-testid={`device-stat-${signal.key}-bar`}
						>
							<span
								class="bg-primary absolute inset-y-0 start-0 rounded-full"
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
