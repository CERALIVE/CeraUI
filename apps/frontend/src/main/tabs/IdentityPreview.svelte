<script lang="ts">
import {
	Activity,
	Gauge,
	Play,
	Radio,
	RotateCcw,
	SatelliteDish,
	Settings,
	Thermometer,
	Wifi,
	Zap,
} from '@lucide/svelte';

import SignalIndicator from '$lib/components/icons/SignalIndicator.svelte';
import { Badge } from '$lib/components/ui/badge';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Separator } from '$lib/components/ui/separator';
import * as Tooltip from '$lib/components/ui/tooltip';
import { isDev } from '$lib/config';
import { BUILD_INFO } from '$lib/env';

type Swatch = { token: string; label: string };

const baseSurfaces: Swatch[] = [
	{ token: 'background', label: '--background' },
	{ token: 'card', label: '--card' },
	{ token: 'popover', label: '--popover' },
	{ token: 'secondary', label: '--secondary' },
	{ token: 'muted', label: '--muted' },
	{ token: 'accent', label: '--accent' },
];

const stateTokens: Swatch[] = [
	{ token: 'destructive', label: '--destructive' },
	{ token: 'status-live', label: '--status-live' },
	{ token: 'status-standby', label: '--status-standby' },
	{ token: 'status-idle', label: '--status-idle' },
];

const statusExtended: Swatch[] = [
	{ token: 'status-success', label: '--status-success' },
	{ token: 'status-info', label: '--status-info' },
	{ token: 'status-warning', label: '--status-warning' },
	{ token: 'status-error', label: '--status-error' },
];

const links = [
	{ index: 1, signal: 85 },
	{ index: 2, signal: 72 },
	{ index: 3, signal: 65 },
	{ index: 4, signal: 90 },
	{ index: 5, signal: 55 },
	{ index: 6, signal: 40 },
];

const signalTiers = [
	{ token: 'signal-excellent', label: 'Excellent', signal: 90 },
	{ token: 'signal-good', label: 'Good', signal: 65 },
	{ token: 'signal-fair', label: 'Fair', signal: 40 },
	{ token: 'signal-weak', label: 'Weak', signal: 15 },
];

const hudLinks = [
	{ index: 1, bars: 3, signal: 85 },
	{ index: 2, bars: 3, signal: 72 },
	{ index: 3, bars: 1, signal: 55 },
];

let inputValue = $state('rtmp.ceralive.tv');
let invalidValue = $state('not-a-port');
let codecValue = $state('h265');

const codecLabels: Record<string, string> = {
	h264: 'H.264 / AVC',
	h265: 'H.265 / HEVC',
	av1: 'AV1',
};
</script>

<div class="bg-background min-h-screen">
	<div class="container mx-auto max-w-7xl space-y-14 px-4 py-8 sm:px-6 sm:py-10">
		<header class="space-y-4">
			<div class="flex items-center gap-3">
				<div
					class="bg-primary/12 ring-primary/25 flex size-11 items-center justify-center rounded-xl ring-1"
				>
					<SatelliteDish class="text-primary size-6" />
				</div>
				{#if isDev}
					<Badge variant="outline" class="font-mono">
						<span class="bg-primary mr-1.5 size-1.5 animate-pulse rounded-full"></span>
						DEV · {BUILD_INFO.MODE}
					</Badge>
				{/if}
			</div>
			<div class="space-y-1.5">
				<h1
					class="text-foreground text-4xl font-bold tracking-tight text-balance sm:text-5xl"
				>
					Ground Control
				</h1>
				<p class="text-muted-foreground max-w-2xl text-pretty">
					Identity preview — the complete token system and component vocabulary on one
					screen. Verify light, dark, and RTL before the redesign ships.
				</p>
			</div>
		</header>

		<Separator />

		<section class="space-y-5">
			<h2 class="text-foreground text-lg font-semibold tracking-tight">Typography</h2>
			<div class="bg-card space-y-4 rounded-xl border p-5 sm:p-6">
				<p class="text-muted-foreground font-mono text-xs">Display · 2xl</p>
				<p class="text-foreground text-4xl font-bold tracking-tight sm:text-5xl">
					Ground Control
				</p>
				<Separator />
				<p class="text-muted-foreground font-mono text-xs">Heading 1 · xl</p>
				<h3 class="text-foreground text-2xl font-semibold tracking-tight">
					Live Streaming Dashboard
				</h3>
				<Separator />
				<p class="text-muted-foreground font-mono text-xs">Heading 2 · lg</p>
				<h4 class="text-foreground text-lg font-semibold">Network Connections</h4>
				<Separator />
				<p class="text-muted-foreground font-mono text-xs">Body · base</p>
				<p class="text-foreground max-w-[70ch]">
					Signal strength indicators show real-time link quality across every bonded
					connection, so the operator reads the whole stream state at a glance.
				</p>
				<Separator />
				<p class="text-muted-foreground font-mono text-xs">Small · caption</p>
				<p class="text-muted-foreground text-sm">Last updated: 2 minutes ago</p>
				<Separator />
				<p class="text-muted-foreground font-mono text-xs">Mono</p>
				<p class="text-foreground font-mono text-sm tabular-nums">
					1,234 kbps&nbsp;&nbsp;·&nbsp;&nbsp;43.2°C&nbsp;&nbsp;·&nbsp;&nbsp;12.1 V
				</p>
			</div>
		</section>

		<section class="space-y-5">
			<h2 class="text-foreground text-lg font-semibold tracking-tight">Color tokens</h2>

			<div class="space-y-3">
				<p class="text-muted-foreground text-sm font-medium">Base surfaces</p>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					{#each baseSurfaces as s}
						<div class="space-y-1.5">
							<div
								class="h-16 rounded-lg border"
								style="background-color: var(--{s.token})"
							></div>
							<p class="text-muted-foreground font-mono text-xs">{s.label}</p>
						</div>
					{/each}
				</div>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-3">
					<p class="text-muted-foreground text-sm font-medium">Text on card</p>
					<div class="bg-card space-y-2 rounded-lg border p-4">
						<p class="text-base font-semibold" style="color: var(--foreground)">
							Foreground — primary readout
						</p>
						<p class="text-sm" style="color: var(--card-foreground)">
							Card foreground — surface body text
						</p>
						<p class="text-sm" style="color: var(--muted-foreground)">
							Muted foreground — secondary metadata
						</p>
					</div>
				</div>
				<div class="space-y-3">
					<p class="text-muted-foreground text-sm font-medium">Primary</p>
					<div
						class="flex h-full min-h-[7rem] flex-col justify-center gap-1 rounded-lg p-4"
						style="background-color: var(--primary)"
					>
						<p class="text-base font-semibold" style="color: var(--primary-foreground)">
							Phosphor lime
						</p>
						<p class="font-mono text-xs" style="color: var(--primary-foreground); opacity: 0.85">
							--primary · --primary-foreground
						</p>
					</div>
				</div>
			</div>

			<div class="space-y-3">
				<p class="text-muted-foreground text-sm font-medium">Stream states</p>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{#each stateTokens as s}
						<div class="space-y-1.5">
							<div
								class="h-16 rounded-lg border"
								style="background-color: var(--{s.token})"
							></div>
							<p class="text-muted-foreground font-mono text-xs">{s.label}</p>
						</div>
					{/each}
				</div>
			</div>

			<div class="space-y-3">
				<p class="text-muted-foreground text-sm font-medium">Semantic status</p>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{#each statusExtended as s}
						<div class="space-y-1.5">
							<div
								class="h-16 rounded-lg border"
								style="background-color: var(--{s.token})"
							></div>
							<p class="text-muted-foreground font-mono text-xs">{s.label}</p>
						</div>
					{/each}
				</div>
			</div>
		</section>

		<section class="space-y-5">
			<div class="flex items-center gap-2">
				<Radio class="text-primary size-5" />
				<h2 class="text-foreground text-lg font-semibold tracking-tight">
					Spectral link ramp
				</h2>
			</div>
			<div class="flex flex-wrap gap-2.5">
				{#each links as link}
					<div
						class="flex items-center gap-2 rounded-full border px-3 py-1.5"
						style="background-color: color-mix(in oklab, var(--link-{link.index}) 14%, transparent); border-color: color-mix(in oklab, var(--link-{link.index}) 45%, transparent); color: var(--link-{link.index})"
					>
						<span class="size-2 rounded-full" style="background-color: var(--link-{link.index})"
						></span>
						<span class="text-sm font-semibold">Link {link.index}</span>
						<span class="font-mono text-xs tabular-nums opacity-90">{link.signal}%</span>
					</div>
				{/each}
			</div>
		</section>

		<section class="space-y-5">
			<div class="flex items-center gap-2">
				<Wifi class="text-primary size-5" />
				<h2 class="text-foreground text-lg font-semibold tracking-tight">
					Signal quality tiers
				</h2>
			</div>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each signalTiers as tier}
					<div class="bg-card flex flex-col items-start gap-2 rounded-lg border p-4">
						<SignalIndicator signal={tier.signal} type="wifi" />
						<p class="text-foreground text-sm font-medium">{tier.label}</p>
						<p class="text-muted-foreground font-mono text-xs">{tier.token}</p>
					</div>
				{/each}
			</div>
		</section>

		<section class="space-y-5">
			<h2 class="text-foreground text-lg font-semibold tracking-tight">Components</h2>

			<div class="grid gap-6 lg:grid-cols-2">
				<div class="bg-card space-y-4 rounded-xl border p-5">
					<p class="text-muted-foreground text-sm font-medium">Buttons</p>
					<div class="flex flex-wrap gap-2.5">
						<Button>Start stream</Button>
						<Button variant="secondary">Configure</Button>
						<Button variant="destructive">Stop stream</Button>
						<Button variant="ghost">Dismiss</Button>
						<Button variant="outline">Details</Button>
					</div>

					<Separator />

					<p class="text-muted-foreground text-sm font-medium">Badges</p>
					<div class="flex flex-wrap items-center gap-2.5">
						<Badge>Default</Badge>
						<Badge variant="secondary">Secondary</Badge>
						<Badge variant="destructive">Destructive</Badge>
						<Badge variant="outline">Outline</Badge>
					</div>

					<Separator />

					<p class="text-muted-foreground text-sm font-medium">Dialog &amp; tooltip</p>
					<div class="flex flex-wrap items-center gap-2.5">
						<Dialog.Root>
							<Dialog.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="outline">Open dialog</Button>
								{/snippet}
							</Dialog.Trigger>
							<Dialog.Content>
								<Dialog.Header>
									<Dialog.Title>Restart encoder?</Dialog.Title>
									<Dialog.Description>
										The active stream will drop for roughly 8 seconds while the encoder
										pipeline reinitializes.
									</Dialog.Description>
								</Dialog.Header>
								<div class="bg-muted/50 rounded-lg p-3 font-mono text-xs">
									ceracoder · pid 2041 · h265 · 1,234 kbps
								</div>
								<Dialog.Footer>
									<Dialog.Close>
										{#snippet child({ props })}
											<Button {...props} variant="ghost">Cancel</Button>
										{/snippet}
									</Dialog.Close>
									<Dialog.Close>
										{#snippet child({ props })}
											<Button {...props} variant="destructive">Restart now</Button>
										{/snippet}
									</Dialog.Close>
								</Dialog.Footer>
							</Dialog.Content>
						</Dialog.Root>

						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="secondary">
										<Gauge class="size-4" />
										Hover for telemetry
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>
								<p class="font-mono text-xs">Bonded throughput: 1,234 kbps</p>
							</Tooltip.Content>
						</Tooltip.Root>
					</div>
				</div>

				<div class="bg-card space-y-4 rounded-xl border p-5">
					<div class="space-y-1.5">
						<Label for="ip-input">SRTLA server address</Label>
						<Input id="ip-input" bind:value={inputValue} placeholder="host.example.tv" />
					</div>

					<div class="space-y-1.5">
						<Label for="port-input">Server port</Label>
						<Input
							id="port-input"
							aria-invalid="true"
							bind:value={invalidValue}
							placeholder="1024–65535"
						/>
						<p class="text-destructive text-xs font-medium">
							Enter a port between 1024 and 65535.
						</p>
					</div>

					<div class="space-y-1.5">
						<Label for="codec-select">Video codec</Label>
						<Select.Root type="single" bind:value={codecValue}>
							<Select.Trigger id="codec-select" class="w-full">
								{codecLabels[codecValue] ?? 'Select codec'}
							</Select.Trigger>
							<Select.Content>
								<Select.Group>
									<Select.Item value="h264">H.264 / AVC</Select.Item>
									<Select.Item value="h265">H.265 / HEVC</Select.Item>
									<Select.Item value="av1">AV1</Select.Item>
								</Select.Group>
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			</div>
		</section>

		<section class="space-y-5">
			<div class="flex items-center gap-2">
				<Activity class="text-primary size-5" />
				<h2 class="text-foreground text-lg font-semibold tracking-tight">HUD bar</h2>
			</div>
			<div
				class="bg-card flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border px-4 py-3"
			>
				<div
					class="flex items-center gap-2 rounded-md px-2.5 py-1"
					style="background-color: color-mix(in oklab, var(--status-live) 16%, transparent); color: var(--status-live)"
				>
					<span
						class="size-2 animate-pulse rounded-full"
						style="background-color: var(--status-live)"
					></span>
					<span class="text-xs font-bold tracking-wide">LIVE</span>
				</div>

				<div class="flex items-center gap-1.5">
					<Zap class="text-muted-foreground size-3.5" />
					<span class="text-foreground font-mono text-sm tabular-nums">1,234 kbps</span>
				</div>

				<div class="flex items-center gap-3">
					{#each hudLinks as link}
						<div class="flex items-center gap-1.5">
							<span
								class="font-mono text-xs font-bold"
								style="color: var(--link-{link.index})">L{link.index}</span
							>
							<div class="flex items-end gap-0.5">
								{#each [1, 2, 3] as bar}
									<span
										class="w-1 rounded-[1px]"
										style="height: {bar * 3 + 2}px; background-color: {bar <= link.bars
											? `var(--link-${link.index})`
											: 'var(--muted)'}"
									></span>
								{/each}
							</div>
							<span
								class="font-mono text-xs tabular-nums"
								style="color: var(--link-{link.index})">{link.signal}%</span
							>
						</div>
					{/each}
				</div>

				<div class="flex items-center gap-3 sm:ms-auto">
					<div class="flex items-center gap-1.5">
						<Thermometer class="text-muted-foreground size-3.5" />
						<span class="text-foreground font-mono text-sm tabular-nums">43.2°C</span>
					</div>
					<div class="flex items-center gap-1.5">
						<Zap class="text-muted-foreground size-3.5" />
						<span class="text-foreground font-mono text-sm tabular-nums">12.1 V</span>
					</div>
				</div>
			</div>
		</section>

		<section class="space-y-5">
			<h2 class="text-foreground text-lg font-semibold tracking-tight">Destinations</h2>
			<div class="grid gap-4 md:grid-cols-3">
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<Radio class="text-primary size-5" />
							Live
						</Card.Title>
						<Card.Description>Streaming &amp; encoder</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div
							class="flex items-center gap-2 rounded-md px-2.5 py-1.5"
							style="background-color: color-mix(in oklab, var(--status-live) 14%, transparent); color: var(--status-live)"
						>
							<span
								class="size-2 animate-pulse rounded-full"
								style="background-color: var(--status-live)"
							></span>
							<span class="text-xs font-bold tracking-wide">LIVE</span>
						</div>
						<div class="flex items-baseline justify-between">
							<span class="text-muted-foreground text-sm">Bitrate</span>
							<span class="text-foreground font-mono text-sm tabular-nums">1,234 kbps</span>
						</div>
					</Card.Content>
					<Card.Footer>
						<Button class="w-full">
							<Play class="size-4" />
							Start stream
						</Button>
					</Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<Wifi class="text-primary size-5" />
							Network
						</Card.Title>
						<Card.Description>Bonded connectivity</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#each [{ index: 1, signal: 85 }, { index: 4, signal: 90 }] as link}
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-2">
									<span
										class="size-2 rounded-full"
										style="background-color: var(--link-{link.index})"
									></span>
									<span class="text-foreground text-sm">Link {link.index}</span>
								</div>
								<span
									class="font-mono text-xs tabular-nums"
									style="color: var(--link-{link.index})">{link.signal}%</span
								>
							</div>
						{/each}
						<Separator />
						<div class="flex items-center gap-2">
							<span class="size-2 rounded-full" style="background-color: var(--status-success)"
							></span>
							<span class="text-sm" style="color: var(--status-success)">Connected</span>
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<Settings class="text-primary size-5" />
							Settings
						</Card.Title>
						<Card.Description>System configuration</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-2.5">
						{#each [{ k: 'Hostname', v: 'cera-01' }, { k: 'Firmware', v: 'v2.4.1' }, { k: 'SSH', v: 'Enabled' }] as row}
							<div class="flex items-center justify-between">
								<span class="text-muted-foreground text-sm">{row.k}</span>
								<span class="text-foreground font-mono text-xs tabular-nums">{row.v}</span>
							</div>
						{/each}
					</Card.Content>
					<Card.Footer>
						<Button variant="destructive" class="w-full">
							<RotateCcw class="size-4" />
							Reboot
						</Button>
					</Card.Footer>
				</Card.Root>
			</div>
		</section>
	</div>
</div>
