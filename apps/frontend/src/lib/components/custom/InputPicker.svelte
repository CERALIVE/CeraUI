<!--
  InputPicker.svelte — hotplug-aware input source picker (Task 34).

  A device picker fed by the live `devices` broadcast: sources grouped by kind
  (HDMI / USB / network ingest / test / audio), with per-device probed caps, an
  Active marker, a Lost (unplugged) state, and a live "Switch" control while
  streaming (→ switchInput RPC + gap toast).

  Presentational: every datum + handler is a prop, so the picker renders
  deterministically under vitest with no subscription/runtime dependency.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CaptureDevice, DeviceKind } from '@ceraui/rpc/schemas';
import { Check, Loader, RadioTower, TriangleAlert } from '@lucide/svelte';

import FieldSyncIndicator from '$lib/components/custom/FieldSyncIndicator.svelte';
import { Button } from '$lib/components/ui/button';

interface Props {
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	selectedInput?: string | undefined;
	isStreaming?: boolean;
	switchingInput?: string | undefined;
	// Gate for live audio-switch (G2): derived from
	// isAudioLiveSwitchEnabled(getCapabilities()) by the parent. When false,
	// audio sources cannot be switched live — the Switch button is disabled.
	audioLiveSwitchEnabled?: boolean;
	// Field-sync key whose applying/applied/failed phase drives the live
	// audio-switch glyph (Task 5 machine). Set by the parent when the engine
	// advertises audio_live_switch.
	audioLiveSwitchField?: string;
	onSelect?: (id: string) => void;
	onSwitch?: (id: string) => void;
}

let {
	devices = [],
	activeInput,
	selectedInput,
	isStreaming = false,
	switchingInput,
	audioLiveSwitchEnabled = false,
	audioLiveSwitchField,
	onSelect,
	onSwitch,
}: Props = $props();

const GROUP_ORDER: DeviceKind[] = [
	'hdmi',
	'uvc_h264',
	'uvc_h265',
	'mjpeg',
	'camlink',
	'usb',
	'network',
	'test',
	'audio',
	'other',
];

const grouped = $derived.by(() => {
	const map = new Map<DeviceKind, CaptureDevice[]>();
	for (const device of devices) {
		// Any kind outside GROUP_ORDER buckets into `other` — an unrecognized kind
		// is never dropped and never rendered as its own group.
		const kind: DeviceKind = GROUP_ORDER.includes(device.kind) ? device.kind : 'other';
		const list = map.get(kind) ?? [];
		list.push(device);
		map.set(kind, list);
	}
	return GROUP_ORDER.filter((kind) => map.has(kind)).map((kind) => ({
		kind,
		devices: map.get(kind) ?? [],
	}));
});

function groupLabel(kind: DeviceKind): string {
	return $LL.live.inputPicker.groups[kind]();
}

function capsLabel(device: CaptureDevice): string {
	if (!device.caps?.length) return '';
	return device.caps
		.slice(0, 3)
		.map((cap) => {
			const res = cap.width && cap.height ? `${cap.width}\u00d7${cap.height}` : '';
			const fps = cap.framerate ? `@${cap.framerate}` : '';
			return [res, fps].filter(Boolean).join(' ');
		})
		.filter(Boolean)
		.join(' \u00b7 ');
}
</script>

<div class="space-y-4" data-testid="input-picker">
	<!-- Hotplug-aware device picker -->
	<div class="flex items-center gap-2">
		<RadioTower aria-hidden={true} class="text-primary size-4 shrink-0" />
		<span class="text-sm font-medium">{$LL.live.inputPicker.title()}</span>
	</div>

	{#if grouped.length === 0}
		<div class="bg-muted/40 rounded-lg border px-4 py-6 text-center">
			<p class="text-muted-foreground text-sm">{$LL.live.inputPicker.empty()}</p>
		</div>
	{:else}
		<div class="space-y-4">
			{#each grouped as group (group.kind)}
				<div class="space-y-2">
					<p class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
						{groupLabel(group.kind)}
					</p>
					<ul class="space-y-2">
						{#each group.devices as device (device.input_id)}
							{@const isActive = device.input_id === activeInput}
							{@const isSelected = device.input_id === selectedInput}
						{@const isSwitching = device.input_id === switchingInput}
						{@const caps = capsLabel(device)}
						<li
								class={`flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors ${
									device.lost
										? 'border-destructive/40 bg-destructive/5 opacity-70'
										: isActive
											? 'border-primary/60 bg-primary/5'
											: 'bg-card'
								}`}
								data-input-id={device.input_id}
								data-active={isActive}
								data-lost={device.lost ? 'true' : 'false'}
							>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="truncate text-sm font-medium">{device.display_name}</span>
										{#if isActive}
											<span
												class="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
											>
												<Check aria-hidden={true} class="size-3" />
												{$LL.live.inputPicker.active()}
											</span>
										{/if}
										{#if device.lost}
											<span
												class="bg-destructive/15 text-destructive inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
											>
												<TriangleAlert aria-hidden={true} class="size-3" />
												{$LL.live.inputPicker.lost()}
											</span>
										{/if}
									</div>
									{#if caps}
										<p class="text-muted-foreground mt-0.5 truncate font-mono text-xs">{caps}</p>
									{/if}
								</div>

							{#if isStreaming}
									<div class="flex items-center gap-2">
										{#if device.kind === 'audio' && audioLiveSwitchField}
											<FieldSyncIndicator
												appliedLabel={$LL.live.inputPicker.audioApplied()}
												applyingLabel={$LL.live.inputPicker.audioApplying()}
												failedLabel={$LL.live.inputPicker.audioFailed()}
												field={audioLiveSwitchField}
												labelHidden={true}
											/>
										{/if}
										<Button
											aria-label={`${$LL.live.inputPicker.switch()} \u2013 ${device.display_name}`}
											data-switch-input={device.input_id}
											disabled={isActive || isSwitching}
											onclick={() => onSwitch?.(device.input_id)}
											size="sm"
											variant={isActive ? 'secondary' : 'default'}
										>
											{#if isSwitching}
												<Loader aria-hidden={true} class="size-3.5 animate-spin" />
												{$LL.live.inputPicker.switching()}
											{:else if isActive}
												{$LL.live.inputPicker.active()}
											{:else}
												{$LL.live.inputPicker.switch()}
											{/if}
										</Button>
									</div>
								{:else}
									<Button
										aria-label={`${$LL.live.inputPicker.select()} \u2013 ${device.display_name}`}
										data-select-input={device.input_id}
										disabled={device.lost}
										onclick={() => onSelect?.(device.input_id)}
										size="sm"
										variant={isSelected ? 'default' : 'outline'}
									>
										{isSelected ? $LL.live.inputPicker.selected() : $LL.live.inputPicker.select()}
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/if}
</div>
