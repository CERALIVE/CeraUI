<!--
  InputPicker.svelte — engine-conditional input source picker (Task 34).

  cerastream → a hotplug-aware device picker fed by the live `devices` broadcast:
    sources grouped by kind (HDMI / USB / network ingest / test / audio), with
    per-device probed caps, an Active marker, a Lost (unplugged) state, and a
    live "Switch" control while streaming (→ switchInput RPC + gap toast).
  ceracoder → the legacy pipeline source Select, rendered UNCHANGED so the old
    engine path is untouched (locked by a snapshot test).

  Presentational: every datum + handler is a prop, so the picker renders both
  modes deterministically under vitest with no subscription/runtime dependency.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CaptureDevice, DeviceKind, Pipeline, StreamingEngineKind } from '@ceraui/rpc/schemas';
import { Check, Loader, RadioTower, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { getSourceLabel } from '$lib/helpers/PipelineHelper';

interface Props {
	engine: StreamingEngineKind;
	// ── ceracoder (legacy) branch ──
	pipelines?: Record<string, Pipeline> | undefined;
	source?: string | undefined;
	sourceInvalid?: boolean;
	sourceError?: string | undefined;
	onSourceChange?: (id: string) => void;
	// ── cerastream (hotplug) branch ──
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	selectedInput?: string | undefined;
	isStreaming?: boolean;
	switchingInput?: string | undefined;
	onSelect?: (id: string) => void;
	onSwitch?: (id: string) => void;
}

let {
	engine,
	pipelines,
	source,
	sourceInvalid = false,
	sourceError,
	onSourceChange,
	devices = [],
	activeInput,
	selectedInput,
	isStreaming = false,
	switchingInput,
	onSelect,
	onSwitch,
}: Props = $props();

// i18n key resolver (mirrors the EncoderDialog helper) so the pure PipelineHelper
// can resolve localized source labels without a store dependency.
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

const GROUP_ORDER: DeviceKind[] = ['hdmi', 'usb', 'network', 'test', 'audio', 'other'];

const grouped = $derived.by(() => {
	const map = new Map<DeviceKind, CaptureDevice[]>();
	for (const device of devices) {
		const list = map.get(device.kind) ?? [];
		list.push(device);
		map.set(device.kind, list);
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

<div class="space-y-4" data-testid="input-picker" data-engine={engine}>
	{#if engine === 'cerastream'}
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
	{:else}
		<!-- Legacy pipeline picker (ceracoder) — rendered unchanged -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="encoder-source">{$LL.settings.inputMode()}</Label>
			<Select.Root
				onValueChange={(value) => onSourceChange?.(value)}
				type="single"
				value={source}
			>
				<Select.Trigger
					id="encoder-source"
					aria-invalid={sourceInvalid}
					class="w-full"
				>
					{source ? getSourceLabel(source, t) : $LL.settings.selectInputMode()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if pipelines}
							{#each Object.entries(pipelines) as [sourceId, pipeline] (sourceId)}
								<Select.Item value={sourceId}>
									<div class="flex flex-col py-1">
										<span class="font-medium">{getSourceLabel(sourceId, t)}</span>
										<span class="text-muted-foreground text-xs">{pipeline.description}</span>
									</div>
								</Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if sourceError}
				<p class="text-destructive text-sm">{sourceError}</p>
			{/if}
		</div>
	{/if}
</div>
