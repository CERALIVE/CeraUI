<!--
  SettingsView.svelte — the Settings destination.

  A lightweight, grouped index of device/system/developer settings. Each entry
  opens an AppDialog (the shared dialog chrome). For Wave 1 the dialog bodies are
  placeholders ("coming soon"); Wave 2 (Tasks 25-27) replaces them with the real
  password / cloud-remote / SSH / logs / updates / power / versions content.

  One concern per dialog — never a mega-dialog.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import {
	Blocks,
	ChevronRight,
	Cloud,
	Gauge,
	Globe,
	Info,
	KeyRound,
	Languages,
	Monitor,
	Palette,
	Power,
	Radio,
	RefreshCw,
	Rocket,
	ScrollText,
	SquareTerminal,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import LocaleSelector from '$lib/components/custom/locale-selector.svelte';
import LowDiskBanner from '$lib/components/custom/LowDiskBanner.svelte';
import ModeToggle from '$lib/components/custom/mode-toggle.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig, getKiosk } from '$lib/rpc/subscriptions.svelte';
import { clearRequestedDialog, getRequestedDialog } from '$lib/stores/dialog-request.svelte';
import { cn } from '$lib/utils';

import CloudRemoteDialog from './dialogs/CloudRemoteDialog.svelte';
import DeviceHealthDialog from './dialogs/DeviceHealthDialog.svelte';
import LogsDialog from './dialogs/LogsDialog.svelte';
import NetworkIngestDialog from './dialogs/NetworkIngestDialog.svelte';
import PasswordDialog from './dialogs/PasswordDialog.svelte';
import PowerDialog from './dialogs/PowerDialog.svelte';
import AddonsSection from './settings/AddonsSection.svelte';
import DeviceStatsSection from './settings/DeviceStatsSection.svelte';
import OnDeviceDisplaySection from './settings/OnDeviceDisplaySection.svelte';
import RemoteControlStatus from './settings/RemoteControlStatus.svelte';
import SshDialog from './dialogs/SshDialog.svelte';
import UpdatesDialog from './dialogs/UpdatesDialog.svelte';
import VersionsDialog from './dialogs/VersionsDialog.svelte';
import WifiCountryDialog from './dialogs/WifiCountryDialog.svelte';

interface Entry {
	key: string;
	title: string;
	desc: string;
	icon: Component;
	destructive?: boolean;
}

interface Group {
	id: string;
	label: string;
	entries: Entry[];
}

// The "Network ingest" entry is retitled "Sources" (test-pattern + rtmp/srt
// ingest live in one dialog). Same entry key + testids; only the copy changes.

// On-Device Display entry desc tracks the live DC-2 state for at-a-glance
// status; falls back to the static description before the first kiosk push.
const kiosk = $derived(getKiosk());
const displayDesc = $derived.by(() => {
	const state = kiosk?.state;
	switch (state) {
		case 'disabled':
			return m["settings.onDeviceDisplay.states.disabled"]();
		case 'enabled-stopped':
			return m["settings.onDeviceDisplay.states.enabledStopped"]();
		case 'enabled-running':
			return m["settings.onDeviceDisplay.states.enabledRunning"]();
		case 'enabled-failed':
			return m["settings.onDeviceDisplay.states.enabledFailed"]();
		case 'failed-no-display':
			return m["settings.onDeviceDisplay.states.failedNoDisplay"]();
		default:
			return m["settings.onDeviceDisplay.description"]();
	}
});

// Autostart streaming. The switch is pessimistic (AsyncSwitch never flips
// optimistically): `autostart` follows the authoritative config broadcast, and
// the RPC result is adopted from `applied` (the persisted value), not the
// intended one. A failed call leaves `autostart` untouched, so AsyncSwitch
// reverts to the prior position.
let autostart = $state(getConfig()?.autostart ?? false);
$effect(() => {
	const cfg = getConfig();
	if (cfg && typeof cfg.autostart === 'boolean') {
		autostart = cfg.autostart;
	}
});

// Autostart routes through the keyed async-operation machine (key 'autostart'),
// which owns the re-entry guard + in-flight `pending` phase + the single failure
// toast (the default `{success}` classifier flags a refused write; a thrown RPC
// uses `failMessage`). On any non-applied outcome we reject so the pessimistic
// AsyncSwitch reverts to the prior position; otherwise we adopt the persisted
// `applied` value.
async function handleAutostartChange(next: boolean) {
	const result = await osCommand({
		key: 'autostart',
		target: next,
		rpc: () => rpc.system.setAutostart({ autostart: next }),
		confirmOnResolve: true,
		failMessage: () => m["settings.index.autostartError"](),
	});
	// undefined → re-entry no-op, a thrown RPC, or a refused write (osCommand
	// already toasted). Reject so AsyncSwitch reverts to the prior value.
	if (!result?.success) throw new Error('autostart_failed');
	autostart = result.applied.autostart;
}

// Language + theme live in the header toolbar on desktop (lg+). On mobile the
// header is kept uncluttered, so they surface here in an Appearance group.
// Mobile-only (mirrors AppDialog's `(min-width: 1024px)` query / Tailwind `lg`).
const isDesktop = new MediaQuery('(min-width: 1024px)');

// Logical grouping (not alphabetical): least-destructive first, power last.
const groups = $derived<Group[]>([
	{
		id: 'system',
		label: m["settings.index.groups.system"](),
		entries: [
			{ key: 'devicePassword', title: m["settings.index.devicePassword"](), desc: m["settings.index.devicePasswordDesc"](), icon: KeyRound },
			{ key: 'wifiCountry', title: m["settings.index.wifiCountry"](), desc: m["settings.index.wifiCountryDesc"](), icon: Globe },
		],
	},
	{
		id: 'streaming',
		label: m["settings.index.groups.streaming"](),
		entries: [
			{ key: 'cloud', title: m["settings.index.cloudRemote"](), desc: m["settings.index.cloudRemoteDesc"](), icon: Cloud },
			{ key: 'networkIngest', title: m["settings.dialogs.sources.title"](), desc: m["settings.dialogs.sources.description"](), icon: Radio },
		],
	},
	{
		id: 'developer',
		label: m["settings.index.groups.developer"](),
		entries: [
			{ key: 'ssh', title: m["settings.index.ssh"](), desc: m["settings.index.sshDesc"](), icon: SquareTerminal },
			{ key: 'logs', title: m["settings.index.logs"](), desc: m["settings.index.logsDesc"](), icon: ScrollText },
		],
	},
	{
		id: 'software',
		label: m["settings.index.groups.software"](),
		entries: [
			{ key: 'updates', title: m["settings.index.updates"](), desc: m["settings.index.updatesDesc"](), icon: RefreshCw },
			{
				key: 'addons',
				title: 'Add-ons',
				desc: 'Install and manage optional device features',
				icon: Blocks,
			},
		],
	},
	{
		id: 'display',
		label: m["settings.index.groups.display"](),
		entries: [{ key: 'onDeviceDisplay', title: m["settings.onDeviceDisplay.title"](), desc: displayDesc, icon: Monitor }],
	},
	{
		id: 'device',
		label: m["settings.index.groups.device"](),
		entries: [
			{
				key: 'deviceHealth',
				title: m["settings.index.deviceHealth"](),
				desc: m["settings.index.deviceHealthDesc"](),
				icon: Gauge,
			},
			{ key: 'power', title: m["settings.index.power"](), desc: m["settings.index.powerDesc"](), icon: Power, destructive: true },
			{ key: 'versions', title: m["settings.index.versions"](), desc: m["settings.index.versionsDesc"](), icon: Info },
		],
	},
]);

// Real dialogs (Tasks 25-27). Each settings entry routes to its own dialog.
let passwordOpen = $state(false);
let cloudOpen = $state(false);
let networkIngestOpen = $state(false);
let sshOpen = $state(false);
let logsOpen = $state(false);
let updatesOpen = $state(false);
let powerOpen = $state(false);
let versionsOpen = $state(false);
let deviceHealthOpen = $state(false);
let displayOpen = $state(false);
let addonsOpen = $state(false);
let wifiCountryOpen = $state(false);

// Fallback placeholder dialog for any not-yet-wired entries.
let open = $state(false);
let active = $state<Entry | null>(null);

function openEntry(entry: Entry) {
	switch (entry.key) {
		case 'devicePassword':
			passwordOpen = true;
			return;
		case 'cloud':
			cloudOpen = true;
			return;
		case 'networkIngest':
			networkIngestOpen = true;
			return;
		case 'ssh':
			sshOpen = true;
			return;
		case 'logs':
			logsOpen = true;
			return;
		case 'updates':
			updatesOpen = true;
			return;
		case 'power':
			powerOpen = true;
			return;
		case 'versions':
			versionsOpen = true;
			return;
		case 'deviceHealth':
			deviceHealthOpen = true;
			return;
		case 'onDeviceDisplay':
			displayOpen = true;
			return;
		case 'addons':
			addonsOpen = true;
			return;
		case 'wifiCountry':
			wifiCountryOpen = true;
			return;
		default:
			active = entry;
			open = true;
	}
}

const ActiveIcon = $derived(active?.icon);

// A notification tap (Todo 24) requests the Updates dialog via the dialog-request
// bus, which has already switched the destination to Settings; open it here.
$effect(() => {
	if (getRequestedDialog() === 'updates-dialog') {
		updatesOpen = true;
		clearRequestedDialog();
	}
});
</script>

<div class="flex-col md:flex">
	<div class="container mx-auto max-w-3xl flex-1 space-y-8 p-4 pt-6 sm:p-8">
		<!-- Header -->
		<header class="space-y-2">
			<h1 class="text-3xl font-bold tracking-tight">{m["settings.index.title"]()}</h1>
			<p class="text-muted-foreground">{m["settings.index.description"]()}</p>
		</header>

		<!-- Grouped settings index -->
		<div class="space-y-7">
			<!-- Live device telemetry first: status at a glance, no dialog to open. -->
			<DeviceStatsSection />

			<!-- Production-readiness signal: low free space on /data points to Logs. -->
			<LowDiskBanner onViewLogs={() => (logsOpen = true)} />

			<!-- Mobile-only: desktop hosts language + theme in the header toolbar instead. -->
			{#if !isDesktop.current}
				<section class="space-y-2.5" data-testid="settings-appearance">
					<h2 class="text-muted-foreground px-1 text-sm font-medium">{m["settings.appearance.title"]()}</h2>
					<div class="divide-border bg-card divide-y overflow-hidden rounded-xl border">
						<div class="flex w-full items-center gap-4 px-4 py-3.5">
							<span
								class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg"
							>
								<Languages class="size-[18px]" />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold">{m["settings.appearance.language"]()}</span>
								<span class="text-muted-foreground block truncate text-xs"
									>{m["settings.appearance.languageDesc"]()}</span
								>
							</span>
							<span class="shrink-0" data-testid="settings-locale-selector">
								<LocaleSelector />
							</span>
						</div>
						<div class="flex w-full items-center gap-4 px-4 py-3.5">
							<span
								class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg"
							>
								<Palette class="size-[18px]" />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold">{m["settings.appearance.theme"]()}</span>
								<span class="text-muted-foreground block truncate text-xs"
									>{m["settings.appearance.themeDesc"]()}</span
								>
							</span>
							<span class="shrink-0" data-testid="settings-theme-toggle">
								<ModeToggle />
							</span>
						</div>
					</div>
				</section>
			{/if}

			{#each groups as group (group.id)}
				<section class="space-y-2.5">
					<h2 class="text-muted-foreground px-1 text-sm font-medium">{group.label}</h2>
					<div class="divide-border bg-card divide-y overflow-hidden rounded-xl border">
						{#if group.id === 'streaming'}
							<RemoteControlStatus />
							<div class="flex w-full items-center gap-4 px-4 py-3.5" data-testid="settings-autostart">
								<span class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
									<Rocket class="size-[18px]" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-semibold">{m["settings.index.autostart"]()}</span>
									<span class="text-muted-foreground block truncate text-xs">{m["settings.index.autostartDesc"]()}</span>
								</span>
								<span class="shrink-0">
									<AsyncSwitch
										aria-label={m["settings.index.autostart"]()}
										checked={autostart}
										data-testid="settings-autostart-switch"
										onCheckedChange={handleAutostartChange}
									/>
								</span>
							</div>
						{/if}
						{#each group.entries as entry (entry.key)}
							{@const EntryIcon = entry.icon}
							<button
								type="button"
								class={cn(
									'group flex w-full items-center gap-4 px-4 py-3.5 text-start transition-colors',
									'hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
								)}
								onclick={() => openEntry(entry)}
							>
								<span
									class={cn(
										'grid size-9 shrink-0 place-items-center rounded-lg',
										entry.destructive
											? 'bg-destructive/10 text-destructive'
											: 'bg-secondary text-foreground',
									)}
								>
									<EntryIcon class="size-[18px]" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-semibold">{entry.title}</span>
									<span class="text-muted-foreground block truncate text-xs">{entry.desc}</span>
								</span>
								{#if entry.destructive}
									<span
										class="bg-destructive text-destructive-foreground grid size-7 shrink-0 place-items-center rounded-md transition-transform group-hover:scale-105"
									>
										<Power class="size-4" />
									</span>
								{:else}
									<ChevronRight
										class="text-muted-foreground/70 size-4 shrink-0 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100"
									/>
								{/if}
							</button>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	</div>
</div>

<!-- Shared, reused dialog: title/description/icon driven by the active entry. -->
<AppDialog
	bind:open
	destructive={active?.destructive ?? false}
	description={active?.desc ?? ''}
	icon={ActiveIcon}
	title={active?.title ?? ''}
>
	<div class="flex flex-col items-start gap-3 py-2">
		<span class="bg-secondary text-muted-foreground grid size-10 place-items-center rounded-lg">
			<Info class="size-5" />
		</span>
		<div class="space-y-1">
			<p class="text-sm font-semibold">{m["settings.index.comingSoon"]()}</p>
			<p class="text-muted-foreground text-sm">{m["settings.index.comingSoonBody"]()}</p>
		</div>
	</div>
</AppDialog>

<!-- Wired settings dialogs (Tasks 25-27) -->
<PasswordDialog bind:open={passwordOpen} />
<CloudRemoteDialog bind:open={cloudOpen} />
<NetworkIngestDialog bind:open={networkIngestOpen} />
<SshDialog bind:open={sshOpen} />
<LogsDialog bind:open={logsOpen} />
<UpdatesDialog bind:open={updatesOpen} />
<PowerDialog bind:open={powerOpen} />
<VersionsDialog bind:open={versionsOpen} />
<DeviceHealthDialog bind:open={deviceHealthOpen} />
<OnDeviceDisplaySection bind:open={displayOpen} />
<AddonsSection bind:open={addonsOpen} />
<WifiCountryDialog bind:open={wifiCountryOpen} />
