<!--
  NetworkIngestSection.svelte — LAN network-ingest sources for the Live destination
  (Task 18).

  The device can bake local RTMP / SRT ingest gateways into its image. When one is
  present, an operator on the same network can publish to it from a phone or a
  hardware encoder (OBS, etc.) and the device encodes that feed for streaming.

  This section surfaces exactly the protocols the backend reports in
  `status.network_ingest` — a board-capability-filtered map where an absent
  (`null`) protocol is one the board does NOT offer, so it renders NOTHING for
  that row. Each present protocol becomes a selectable SOURCE row (choosing it
  sets `config.pipeline` to the matching pipeline id, NOT `selected_video_input`,
  which reconciliation would strip for a non-device id) plus an expandable
  "how to publish" panel with the publish URL, a copy button, a QR, and an
  InfoPopover.

  House rules honored:
   • A gateway whose systemd service is inactive (`service_active === false`)
     renders the row DISABLED with a `title` reason — never hidden, never a
     "coming soon" / data-debt treatment (this is a service-gated state).
   • Pipeline switching is disabled while streaming (a `title` reason explains).

  Data in, handler self-owned: the DATA (networkIngest / pipelines /
  selectedPipeline / isStreaming) arrives as props so the section renders
  deterministically under vitest; the selection dispatch owns the per-field-sync
  lock contract (`beginFieldSync → markFieldApplying → markFieldApplied /
  markFieldFailed` on the `pipeline` field), mirroring LiveView's
  `handleSelectInput`.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	NetworkIngest,
	Pipelines,
	RequiresGateway,
	StreamingSetConfigOutput,
} from '@ceraui/rpc/schemas';
import { VIDEO_SOURCE_LABELS } from '@ceraui/rpc/schemas';
import { Check, Copy, QrCode, Radio } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { generateDeviceAccessQr } from '$lib/helpers/NetworkHelper';
import { rpc } from '$lib/rpc/client';
import {
	beginFieldSync,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from '$lib/rpc/field-sync-state.svelte';
import { deriveNetworkIngestRows } from '$lib/streaming/networkIngestRows';

interface Props {
	/** `status.network_ingest` — a `null`/absent protocol renders nothing. */
	networkIngest?: NetworkIngest | null | undefined;
	/** `getPipelines()?.pipelines` — used to resolve the pipeline id per protocol. */
	pipelines?: Pipelines | undefined;
	/** The currently-selected `config.pipeline` (drives the "selected" state). */
	selectedPipeline?: string | undefined;
	/** Streaming locks pipeline switching (config.pipeline can't change live). */
	isStreaming?: boolean;
}

let {
	networkIngest,
	pipelines,
	selectedPipeline,
	isStreaming = false,
}: Props = $props();

/** The field key for the per-field-sync lock — a config field, not a status field. */
const PIPELINE_FIELD = 'pipeline';

interface IngestRow {
	protocol: RequiresGateway;
	pipelineId: string;
	label: string;
	/** Publish URL, or `null` in the addressless (`no_lan_or_hotspot_address`) state. */
	url: string | null;
	serviceActive: boolean;
	selected: boolean;
	/** Disabled when the gateway is blocked (down OR addressless) OR while streaming. */
	disabled: boolean;
	/** Human reason for the `title` tooltip when disabled (empty when actionable). */
	reason: string;
	/** Short status sub-label under the row label. */
	statusLabel: string;
	/** Whether the status sub-label uses the warning treatment. */
	statusWarn: boolean;
	/** Publish instructions (URL + copy + QR) render only when a url exists. */
	showInstructions: boolean;
}

// The structural derivation (protocol order, pipeline id, availability verdict,
// addressless) is SHARED with SourceSection via `deriveNetworkIngestRows` (Task 12)
// so both surfaces read the SAME truth — routed through pipelineAvailability, never
// re-derived inline. This component maps that structural row onto its own i18n copy.
const rows = $derived.by<IngestRow[]>(() =>
	deriveNetworkIngestRows({
		networkIngest,
		pipelines,
		selectedPipeline,
		isStreaming,
	}).map((row) => {
		const label = VIDEO_SOURCE_LABELS[row.protocol] ?? row.protocol;
		let reason = '';
		if (row.addressless) {
			reason = $LL.live.networkIngest.noAddress({ protocol: label });
		} else if (row.gatewayBlocked) {
			reason = $LL.live.networkIngest.serviceInactive({ protocol: label });
		} else if (row.streamingLocked) {
			reason = $LL.live.networkIngest.streamingLocked();
		}
		return {
			protocol: row.protocol,
			pipelineId: row.pipelineId,
			label,
			url: row.url,
			serviceActive: row.serviceActive,
			selected: row.selected,
			disabled: row.disabled,
			reason,
			statusLabel: row.addressless
				? $LL.live.networkIngest.noAddressStatus()
				: row.serviceActive
					? $LL.live.networkIngest.active()
					: $LL.live.networkIngest.inactive(),
			statusWarn: row.addressless || !row.serviceActive,
			// No url ⇒ nothing to encode into a QR or copy: suppress the panel.
			showInstructions: row.url !== null,
		};
	}),
);

// ── Selection dispatch (per-field-sync lock on the `pipeline` field) ──
async function handleSelect(row: IngestRow): Promise<void> {
	if (row.disabled || row.selected) return;
	beginFieldSync(PIPELINE_FIELD, row.pipelineId);
	markFieldApplying(PIPELINE_FIELD);
	try {
		const result = await rpc.streaming.setConfig({ pipeline: row.pipelineId });
		// Release the lock to the SERVER-APPLIED value (`result.applied.pipeline`),
		// never the optimistic id we sent. A rejected setConfig (`success:false`) or a
		// success that omits the field is NOT a confirmed apply: revert the lock to
		// the prior config value and surface the same calm error the catch path does.
		if (result.success && result.applied?.pipeline !== undefined) {
			markFieldApplied(PIPELINE_FIELD, result.applied.pipeline);
		} else {
			markFieldFailed(PIPELINE_FIELD, selectedPipeline);
			toast.error($LL.notifications.saveFailed());
		}
	} catch {
		markFieldFailed(PIPELINE_FIELD, selectedPipeline);
		toast.error($LL.notifications.saveFailed());
	}
}

// ── Per-protocol publish-instruction QR data URLs (URL only, never a secret) ──
let qrDataUrls = $state<Record<string, string>>({});
$effect(() => {
	let cancelled = false;
	const next: Record<string, string> = {};
	Promise.all(
		rows.map(async (row) => {
			if (!row.url) return;
			try {
				next[row.protocol] = await generateDeviceAccessQr(row.url);
			} catch {
				// A QR failure just omits the image — the URL + copy still work.
			}
		}),
	).then(() => {
		if (!cancelled) qrDataUrls = next;
	});
	return () => {
		cancelled = true;
	};
});

async function copyUrl(url: string | null): Promise<void> {
	if (!url) return;
	try {
		await navigator.clipboard.writeText(url);
		toast.success($LL.live.networkIngest.copied());
	} catch {
		toast.error($LL.live.networkIngest.copyFailed());
	}
}
</script>

{#if rows.length > 0}
	<Card.Root data-testid="network-ingest-section">
		<Card.Content class="space-y-4 p-4 sm:p-6">
			<!-- Section header + info affordance -->
			<div class="flex items-center gap-1">
				<Radio aria-hidden={true} class="text-primary size-4 shrink-0" />
				<span class="text-sm font-semibold">{$LL.live.networkIngest.title()}</span>
				<InfoPopover
					body={$LL.live.networkIngest.infoBody()}
					testId="info-network-ingest"
					title={$LL.live.networkIngest.infoTitle()}
				/>
			</div>
			<p class="text-muted-foreground text-xs">{$LL.live.networkIngest.subtitle()}</p>

			<ul class="space-y-3">
				{#each rows as row (row.protocol)}
					<li data-protocol={row.protocol} data-testid={`network-ingest-row-${row.protocol}`}>
						<!-- Selectable source row: choosing it sets config.pipeline. -->
						<button
							class="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors {row.selected
								? 'border-primary bg-primary/10'
								: 'border-border hover:bg-accent/50'} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
							data-selected={row.selected}
							data-testid={`network-ingest-select-${row.protocol}`}
							disabled={row.disabled}
							onclick={() => handleSelect(row)}
							title={row.reason || undefined}
							type="button"
						>
							<span class="flex min-w-0 flex-col">
								<span class="truncate text-sm font-medium">{row.label}</span>
								<span
									class="text-xs {row.statusWarn
										? 'text-status-warning'
										: 'text-muted-foreground'}"
									data-testid={`network-ingest-status-${row.protocol}`}
								>
									{row.statusLabel}
								</span>
							</span>
							{#if row.selected}
								<span
									class="text-primary inline-flex items-center gap-1 text-xs font-semibold"
								>
									<Check aria-hidden={true} class="size-4" />
									{$LL.live.networkIngest.selected()}
								</span>
							{/if}
						</button>

						<!-- Expandable "how to publish" panel (URL + copy + QR + info).
						     Suppressed in the addressless state — there is no url to publish to. -->
						{#if row.showInstructions && row.url}
						<details class="group mt-1.5">
							<summary
								class="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs font-medium select-none"
								data-testid={`network-ingest-instructions-toggle-${row.protocol}`}
							>
								<QrCode aria-hidden={true} class="size-3.5" />
								{$LL.live.networkIngest.instructionsToggle()}
							</summary>
							<div
								class="bg-muted/40 mt-2 flex flex-col items-center gap-3 rounded-lg border p-4"
								data-testid={`network-ingest-instructions-${row.protocol}`}
							>
								<p class="text-muted-foreground text-center text-xs">
									{$LL.live.networkIngest.instructions()}
								</p>

								{#if qrDataUrls[row.protocol]}
									<img
										class="size-40 rounded-md bg-white p-2"
										alt={$LL.live.networkIngest.qrLabel()}
										data-testid={`network-ingest-qr-${row.protocol}`}
										src={qrDataUrls[row.protocol]}
									/>
								{/if}

								<div class="flex w-full items-center gap-2">
									<!-- dir="ltr": the URL is always Latin/ASCII; never mirror it. -->
									<code
										class="bg-background min-w-0 flex-1 truncate rounded-md border px-2.5 py-2 font-mono text-xs"
										data-testid={`network-ingest-url-${row.protocol}`}
										dir="ltr"
									>
										{row.url}
									</code>
									<Button
										aria-label={$LL.live.networkIngest.copy()}
										data-testid={`network-ingest-copy-${row.protocol}`}
										onclick={() => copyUrl(row.url)}
										size="icon"
										title={$LL.live.networkIngest.copy()}
										variant="outline"
									>
										<Copy class="size-4" />
									</Button>
								</div>
							</div>
						</details>
						{/if}
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
