<!--
  DeviceStatsSection.svelte — the five-signal device telemetry panel (T33).

  Surfaces exactly the five signals of the backend `device-stats` broadcast
  (T32): disk, CPU load, SoC temperature, network rate, and boot slot. socTemp
  is taken straight from the device-stats event — never a second sensors
  subscription. Every signal degrades to a calm "—" placeholder when its source
  reports null / "unavailable", so a dead source never blanks or NaNs the panel.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Component } from 'svelte';
import { ArrowDownUp, CircuitBoard, Cpu, HardDrive, Thermometer } from '@lucide/svelte';

import { getDeviceStats } from '$lib/rpc/subscriptions.svelte';

const t = $derived($LL.settings.deviceStats);

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

interface Row {
	key: string;
	icon: Component;
	label: string;
	sub?: string;
	// `null` ⇒ source unavailable ⇒ render the placeholder, never blank/NaN.
	value: string | null;
}

const rows = $derived.by<Row[]>(() => {
	const s = stats;
	const disk = s?.disk ?? null;
	const net = s?.ifaceRxTx ?? null;
	const slot = s?.raucSlot;

	return [
		{
			key: 'disk',
			icon: HardDrive,
			label: t.disk(),
			sub: disk && disk.type !== 'unknown' ? disk.type : undefined,
			value: disk ? `${humanBytes(disk.used)} / ${humanBytes(disk.total)}` : null,
		},
		{
			key: 'cpuLoad',
			icon: Cpu,
			label: t.cpuLoad(),
			value: s && s.cpuLoad1 != null ? s.cpuLoad1.toFixed(2) : null,
		},
		{
			key: 'socTemp',
			icon: Thermometer,
			label: t.socTemp(),
			value: s && s.socTemp != null ? `${s.socTemp.toFixed(1)} \u00b0C` : null,
		},
		{
			key: 'network',
			icon: ArrowDownUp,
			label: t.network(),
			sub: net?.iface,
			value: net ? `\u2191 ${humanRate(net.txBytesPerSec)}  \u2193 ${humanRate(net.rxBytesPerSec)}` : null,
		},
		{
			key: 'bootSlot',
			icon: CircuitBoard,
			label: t.bootSlot(),
			value: slot && slot !== RAUC_UNAVAILABLE ? slot : null,
		},
	];
});
</script>

<section class="space-y-2.5" data-testid="device-stats">
	<h2 class="text-muted-foreground px-1 text-sm font-medium">{t.title()}</h2>
	<div class="divide-border bg-card divide-y overflow-hidden rounded-xl border">
		{#each rows as row (row.key)}
			{@const RowIcon = row.icon}
			<div class="flex w-full items-center gap-4 px-4 py-3.5" data-testid={`device-stat-${row.key}`}>
				<span class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
					<RowIcon class="size-[18px]" />
				</span>
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-semibold">{row.label}</span>
					{#if row.sub}
						<span class="text-muted-foreground block truncate text-xs">{row.sub}</span>
					{/if}
				</span>
				{#if row.value === null}
					<span
						class="text-muted-foreground/60 shrink-0 font-mono text-sm"
						data-testid={`device-stat-${row.key}-value`}
						title={t.unavailable()}
						aria-label={t.unavailable()}
					>
						&mdash;
					</span>
				{:else}
					<span
						class="text-foreground shrink-0 font-mono text-sm tabular-nums"
						data-testid={`device-stat-${row.key}-value`}
					>
						{row.value}
					</span>
				{/if}
			</div>
		{/each}
	</div>
</section>
