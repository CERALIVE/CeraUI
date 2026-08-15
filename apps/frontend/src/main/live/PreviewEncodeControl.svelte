<!--
  PreviewEncodeControl.svelte — the operator's hardware-preview-encoder switch.

  Mounted by PreviewDisclosure (the preview host) rather than by PreviewCanvas:
  the canvas owns the socket, the token mint and the delivery-tier ladder, and
  none of those are involved here. This control touches the PERSISTED config and
  the status channel only.

  Three separate facts drive it, and the component's job is to keep them apart —
  see `preview-encode-state.ts` for the derivation and why each channel is the
  one it is. The switch writes `streaming.setConfig({ previewEncode })`, which
  the engine can only honour when the next session's graph is built, hence the
  "applies to the next stream" helper. The active line and the fallback band read
  the LIVE session's realized encoder, so an operator who asked for hardware and
  got software is told so, and told why.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/i18n-svelte5';
import type { PreviewEncodeMode } from '@ceraui/rpc/schemas';
import { Cpu, TriangleAlert } from '@lucide/svelte';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import { rpc } from '$lib/rpc/client';
import { getCapabilities, getConfig, getStatus } from '$lib/rpc/subscriptions.svelte';

import { derivePreviewEncodeView } from './preview-encode-state';

const t = $derived($LL.live.preview.encode);

const view = $derived(
	derivePreviewEncodeView(getCapabilities(), getStatus()?.preview_encoder_realized, getConfig()),
);

const activeText = $derived(
	view.active === null
		? t.activeNone()
		: view.active.mode === 'hardware'
			? t.activeHardware({ element: view.active.element })
			: t.activeSoftware({ element: view.active.element }),
);

const fallbackMessage = $derived(
	view.fallback?.code === 'property-failure'
		? t.fallbackPropertyFailure()
		: t.fallbackFactoryMissing(),
);

/**
 * Reject on a refused write so `AsyncSwitch` reverts: the switch must never show
 * a preference the device did not actually persist.
 */
async function requestMode(hardware: boolean): Promise<void> {
	const previewEncode: PreviewEncodeMode = hardware ? 'hardware' : 'software';
	const result = await rpc.streaming.setConfig({ previewEncode });
	if (!result?.success || result.applied?.previewEncode !== previewEncode) {
		throw new Error('preview_encode_not_applied');
	}
}
</script>

{#if view.visible}
	<div class="bg-muted/30 mt-3 rounded-lg border px-3 py-2.5" data-testid="preview-encode-control">
		<div class="flex items-center justify-between gap-3">
			<div class="min-w-0">
				<p class="flex items-center gap-1.5 text-sm font-medium">
					<Cpu aria-hidden="true" class="size-3.5 shrink-0" />
					{t.label()}
				</p>
				<p class="text-muted-foreground text-xs">{t.description()}</p>
				<p class="text-muted-foreground/80 mt-0.5 text-xs" data-testid="preview-encode-helper">
					{t.helper()}
				</p>
			</div>
			<AsyncSwitch
				aria-label={t.label()}
				checked={view.requested === 'hardware'}
				data-testid="preview-encode-switch"
				onCheckedChange={requestMode}
			/>
		</div>

		<!-- The divider is the requested-vs-realized seam: above it is what the
		     operator asked for, below it is what the engine is actually running. -->
		<div class="mt-2.5 space-y-2 border-t pt-2.5">
			<p
				class="text-muted-foreground font-mono text-xs"
				data-mode={view.active?.mode ?? 'none'}
				data-testid="preview-encode-active"
			>
				<span class="font-sans">{t.activeLabel()}:</span>
				{activeText}
			</p>

			{#if view.fallback}
				<div
					class="border-status-warning/40 bg-status-warning/10 space-y-1 rounded-md border px-2.5 py-2"
					data-code={view.fallback.code}
					data-testid="preview-encode-fallback"
					role="status"
				>
					<p class="flex items-center gap-1.5 text-xs font-medium">
						<TriangleAlert aria-hidden="true" class="text-status-warning size-3.5 shrink-0" />
						{t.fallbackTitle()}
					</p>
					<p class="text-muted-foreground text-xs" data-testid="preview-encode-fallback-message">
						{fallbackMessage}
					</p>
					{#if view.fallback.code === 'property-failure'}
						<p class="text-muted-foreground text-xs">
							{t.fallbackPropertyLabel()}:
							<code class="font-mono" data-testid="preview-encode-fallback-property"
								>{view.fallback.property}</code
							>
						</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
