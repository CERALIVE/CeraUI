<!--
  LiveSourceSwitch.svelte — the live capture-source switch card (Task T12).

  While streaming, LiveView mounts LiveCockpit (NOT IdleCockpit), so SourceSection's
  streaming-branch switch buttons — the only place the live input switch lived — are
  never rendered: the live switch was UNREACHABLE from any mounted surface. This
  compact card is that surface. It mirrors SourceSection's streaming-branch button
  contract EXACTLY (`data-switch-input`, disabled/label semantics) so the live switch
  — and T7's deferred audio-follow flow that rides on it — is reachable end-to-end.

  RENDER GATE (load-bearing): the card renders ONLY when BOTH hold —
    (a) the CURRENTLY-RUNNING source is capture-origin
        (`sources.find(s => s.id === (activeEncode?.active_input ?? config.source))
          ?.origin === 'capture'`) — cerastream sessions are mutually exclusive, so a
        network/test stream has no capture legs and `switch_input` on a leg-less id
        always fails; a Switch button in that mode would be a lie; AND
    (b) ≥2 capture sources exist (nothing to switch between with one).
  Otherwise it renders NOTHING (absent from the DOM — not an empty card).

  Presentational: owns NO `$state`, NO RPC. `onSwitch` is LiveView's handleSwitchInput.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	CaptureStreamSource,
	ConfigMessage,
	DeviceKind,
	SourcesMessage,
} from '@ceraui/rpc/schemas';
import { Cable, Radio, RefreshCw, Usb, Video } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';

interface Props {
	/** The unified `sources` broadcast — capture rows are filtered out of it here. */
	sources?: SourcesMessage | undefined;
	/** Active-config truth — `config.source` names the selected source id. */
	config?: ConfigMessage | undefined;
	/** Engine `active_encode` — its `active_input` is the running capture leg. */
	activeEncode?: ActiveEncode | null | undefined;
	/** Engine `active_input` — the capture source the engine is currently running. */
	activeInput?: string | undefined;
	/** The capture source with an in-flight live switch (optimistic latch). */
	switchingInput?: string | undefined;
	/** Dispatch a live input switch (LiveView's handleSwitchInput). */
	onSwitch?: (id: string) => void;
}

const {
	sources,
	config,
	activeEncode,
	activeInput,
	switchingInput,
	onSwitch,
}: Props = $props();

// Every capture-origin source, in broadcast order (mirrors SourceSection's filter).
const captureSources = $derived(
	(sources?.sources ?? []).filter(
		(s): s is CaptureStreamSource => s.origin === 'capture',
	),
);

// The id the engine is running right now: engine truth (`active_input`) wins, then
// the saved `config.source`. Its origin decides whether a live switch is even valid.
const runningId = $derived(activeEncode?.active_input ?? config?.source);
const runningSource = $derived(
	runningId ? sources?.sources.find((s) => s.id === runningId) : undefined,
);

// The full render gate: a capture session AND something to switch between.
const showCard = $derived(runningSource?.origin === 'capture' && captureSources.length >= 2);

// Capture kind → coarse device family (drives icon + badge) — mirrors SourceSection.
type KindFamily = 'hdmi' | 'usb' | 'network' | 'other';
function kindFamily(kind: DeviceKind): KindFamily {
	if (kind === 'hdmi') return 'hdmi';
	if (kind === 'network') return 'network';
	if (
		kind === 'usb' ||
		kind === 'uvc_h264' ||
		kind === 'uvc_h265' ||
		kind === 'mjpeg' ||
		kind === 'camlink'
	) {
		return 'usb';
	}
	return 'other';
}
const KIND_ICON = { hdmi: Cable, usb: Usb, network: Radio, other: Video } as const;

// i18n dotted-key resolver (mirrors SourceSection) — no store dep, safe passthrough.
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
// The SPECIFIC pipeline/profile label — mirrors SourceSection so the same device
// reads identically ("UVC H.264", "MJPEG", "Cam Link") whether idle or streaming,
// never the coarse "USB" collapse. `kindFamily` above still drives only the icon.
function kindLabel(kind: DeviceKind): string {
	return t(`live.inputPicker.groups.${kind}`);
}
// Hardware-encode UVC accent, mirroring SourceSection's kind badge.
function kindBadgeClass(kind: DeviceKind): string {
	return kind === 'uvc_h264' || kind === 'uvc_h265'
		? 'bg-primary/10 text-primary'
		: 'bg-muted text-muted-foreground';
}
</script>

{#if showCard}
	<Card.Root data-testid="live-source-switch">
		<Card.Content class="space-y-3 p-4 sm:p-5">
			<div class="flex items-center gap-1.5">
				<RefreshCw aria-hidden={true} class="text-primary size-4 shrink-0" />
				<span class="text-sm font-semibold">{$LL.live.summary.switchTitle()}</span>
			</div>

			<ul class="space-y-2">
				{#each captureSources as source (source.id)}
					{@const RowIcon = KIND_ICON[kindFamily(source.kind)]}
					{@const isActive = source.id === activeInput}
					<li
						class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 {isActive
							? 'border-primary/40 bg-primary/5'
							: 'border-border'}"
						data-source-switch-row={source.id}
						data-active={isActive}
					>
						<span class="flex min-w-0 items-center gap-2.5">
							<RowIcon
								aria-hidden={true}
								class="size-4 shrink-0 {isActive ? 'text-primary' : 'text-muted-foreground'}"
							/>
							<span class="truncate text-sm font-medium">{source.displayName}</span>
							<span
								class="{kindBadgeClass(source.kind)} shrink-0 rounded px-1.5 py-0.5 text-xs font-medium"
								data-source-kind={source.kind}
							>
								{kindLabel(source.kind)}
							</span>
						</span>

						<Button
							aria-label={`${$LL.live.inputPicker.switch()} \u2013 ${source.displayName}`}
							data-switch-input={source.id}
							disabled={source.id === activeInput ||
								source.id === switchingInput ||
								source.lost === true}
							onclick={() => onSwitch?.(source.id)}
							size="sm"
							variant={source.id === activeInput ? 'secondary' : 'default'}
						>
							{#if source.id === switchingInput}
								{$LL.live.inputPicker.switching()}
							{:else if source.id === activeInput}
								{$LL.live.inputPicker.active()}
							{:else}
								{$LL.live.inputPicker.switch()}
							{/if}
						</Button>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
