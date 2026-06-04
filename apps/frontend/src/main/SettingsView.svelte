<!--
  SettingsView.svelte — the Settings destination.

  A lightweight, grouped index of device/system/developer settings. Each entry
  opens an AppDialog (the shared dialog chrome). For Wave 1 the dialog bodies are
  placeholders ("coming soon"); Wave 2 (Tasks 25-27) replaces them with the real
  password / cloud-remote / SSH / logs / updates / power / versions content.

  One concern per dialog — never a mega-dialog.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	ChevronRight,
	Cloud,
	Info,
	KeyRound,
	Languages,
	Palette,
	Power,
	RefreshCw,
	ScrollText,
	SquareTerminal,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import LocaleSelector from '$lib/components/custom/locale-selector.svelte';
import ModeToggle from '$lib/components/custom/mode-toggle.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { cn } from '$lib/utils';

import CloudRemoteDialog from './dialogs/CloudRemoteDialog.svelte';
import LogsDialog from './dialogs/LogsDialog.svelte';
import PasswordDialog from './dialogs/PasswordDialog.svelte';
import PowerDialog from './dialogs/PowerDialog.svelte';
import SshDialog from './dialogs/SshDialog.svelte';
import UpdatesDialog from './dialogs/UpdatesDialog.svelte';
import VersionsDialog from './dialogs/VersionsDialog.svelte';

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

const t = $derived($LL.settings.index);
const appearance = $derived($LL.settings.appearance);

// Language + theme live in the header toolbar on desktop (lg+). On mobile the
// header is kept uncluttered, so they surface here in an Appearance group.
// Mobile-only (mirrors AppDialog's `(min-width: 1024px)` query / Tailwind `lg`).
const isDesktop = new MediaQuery('(min-width: 1024px)');

// Logical grouping (not alphabetical): least-destructive first, power last.
const groups = $derived<Group[]>([
	{
		id: 'system',
		label: t.groups.system(),
		entries: [{ key: 'devicePassword', title: t.devicePassword(), desc: t.devicePasswordDesc(), icon: KeyRound }],
	},
	{
		id: 'streaming',
		label: t.groups.streaming(),
		entries: [{ key: 'cloudRemote', title: t.cloudRemote(), desc: t.cloudRemoteDesc(), icon: Cloud }],
	},
	{
		id: 'developer',
		label: t.groups.developer(),
		entries: [
			{ key: 'ssh', title: t.ssh(), desc: t.sshDesc(), icon: SquareTerminal },
			{ key: 'logs', title: t.logs(), desc: t.logsDesc(), icon: ScrollText },
		],
	},
	{
		id: 'software',
		label: t.groups.software(),
		entries: [{ key: 'updates', title: t.updates(), desc: t.updatesDesc(), icon: RefreshCw }],
	},
	{
		id: 'device',
		label: t.groups.device(),
		entries: [
			{ key: 'power', title: t.power(), desc: t.powerDesc(), icon: Power, destructive: true },
			{ key: 'versions', title: t.versions(), desc: t.versionsDesc(), icon: Info },
		],
	},
]);

// Real dialogs (Tasks 25-27). Each settings entry routes to its own dialog.
let passwordOpen = $state(false);
let cloudOpen = $state(false);
let sshOpen = $state(false);
let logsOpen = $state(false);
let updatesOpen = $state(false);
let powerOpen = $state(false);
let versionsOpen = $state(false);

// Fallback placeholder dialog for any not-yet-wired entries.
let open = $state(false);
let active = $state<Entry | null>(null);

function openEntry(entry: Entry) {
	switch (entry.key) {
		case 'devicePassword':
			passwordOpen = true;
			return;
		case 'cloudRemote':
			cloudOpen = true;
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
		default:
			active = entry;
			open = true;
	}
}

const ActiveIcon = $derived(active?.icon);
</script>

<div class="flex-col md:flex">
	<div class="container mx-auto max-w-3xl flex-1 space-y-8 p-4 pt-6 sm:p-8">
		<!-- Header -->
		<header class="space-y-2">
			<h1 class="text-3xl font-bold tracking-tight">{t.title()}</h1>
			<p class="text-muted-foreground">{t.description()}</p>
		</header>

		<!-- Grouped settings index -->
		<div class="space-y-7">
			<!-- Mobile-only: desktop hosts language + theme in the header toolbar instead. -->
			{#if !isDesktop.current}
				<section class="space-y-2.5" data-testid="settings-appearance">
					<h2 class="text-muted-foreground px-1 text-sm font-medium">{appearance.title()}</h2>
					<div class="divide-border bg-card divide-y overflow-hidden rounded-xl border">
						<div class="flex w-full items-center gap-4 px-4 py-3.5">
							<span
								class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg"
							>
								<Languages class="size-[18px]" />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold">{appearance.language()}</span>
								<span class="text-muted-foreground block truncate text-xs"
									>{appearance.languageDesc()}</span
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
								<span class="block truncate text-sm font-semibold">{appearance.theme()}</span>
								<span class="text-muted-foreground block truncate text-xs"
									>{appearance.themeDesc()}</span
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
			<p class="text-sm font-semibold">{t.comingSoon()}</p>
			<p class="text-muted-foreground text-sm">{t.comingSoonBody()}</p>
		</div>
	</div>
</AppDialog>

<!-- Wired settings dialogs (Tasks 25-27) -->
<PasswordDialog bind:open={passwordOpen} />
<CloudRemoteDialog bind:open={cloudOpen} />
<SshDialog bind:open={sshOpen} />
<LogsDialog bind:open={logsOpen} />
<UpdatesDialog bind:open={updatesOpen} />
<PowerDialog bind:open={powerOpen} />
<VersionsDialog bind:open={versionsOpen} />
