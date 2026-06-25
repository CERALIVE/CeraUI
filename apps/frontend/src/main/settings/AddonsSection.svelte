<!--
  AddonsSection.svelte — the Add-ons settings surface (T31).

  A generic, descriptor-driven catalogue of optional device add-ons. Each add-on
  renders the SAME card (no per-add-on bespoke UI): name, a derived meta line, a
  pessimistic enable toggle, a 7-state status badge, install progress, and the
  disk-size impact. Descriptors are loaded once from rpc.addons.list(); live state
  tracks the backend `addons` broadcast (getAddons) so install progress and a
  crash-loop auto-disable reflect without a refresh.

  The toggle is pessimistic (AsyncSwitch): it drives install/uninstall and only
  settles once the RPC resolves, reverting on error. In emulated mode the backend
  rejects mutating ops, so the toggle reverts and a calm banner appears (mirrors
  the kiosk unavailable pattern) instead of an error toast.
-->
<script lang="ts">
import type { AddonDescriptor, AddonState } from '@ceraui/rpc/schemas';
import { Ban, Blocks, BookOpen, ChevronDown, ExternalLink, HardDrive, LoaderCircle, Package, TriangleAlert } from '@lucide/svelte';
import { onMount } from 'svelte';
import { toast } from 'svelte-sonner';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import * as Tooltip from '$lib/components/ui/tooltip';
import { clearOperation, osCommand } from '$lib/rpc/async-operation.svelte';
import { type AddonManagerPhase, rpc } from '$lib/rpc/client';
import { getAddons } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

// The backend returns this from a mutating op attempted off a real board. It has
// no @ceraui/rpc/schemas export (unlike KIOSK_UNAVAILABLE_ERROR), so it is named
// here to drive the calm banner instead of an error toast.
const ADDON_UNAVAILABLE_ERROR = 'addon_unavailable_in_emulated_mode';

const DEFAULT_STATE: AddonState = { enabled: false, phase: 'idle', autoDisabled: false };

// Descriptors are static (image-baked); runtime state is live. Holding them apart
// lets the broadcast overlay state without ever touching the descriptor list.
let descriptors = $state<AddonDescriptor[]>([]);
let seedStates = $state<Record<string, AddonState>>({});
let loaded = $state(false);
let unavailable = $state(false);

// Detected board, resolved once on open. Drives the client-side compatibility
// reflection: the server is the authoritative gate (addons.procedure rejects an
// incompatible install), the UI only mirrors it so an unusable toggle reads as
// disabled-with-a-reason instead of failing on tap. `null` = not yet known, in
// which case nothing is gated (fail-open until the board is resolved).
let effectiveHardware = $state<string | null>(null);

// Per-add-on inline warning surfaced from the backend's STRUCTURED enable error
// (addon_conflict / addon_dependency_missing / addon_incompatible_hardware).
// The toggle still reverts (the op failed), but instead of a transient toast the
// reason stays pinned to the card so the operator sees why the enable was blocked.
let actionErrors = $state<Record<string, string>>({});

// Ids whose docs/help panel is expanded. Descriptor-driven: only add-ons that
// ship a `docs` string (or a `helpUrl`) get the affordance at all.
let docsOpen = $state<Record<string, boolean>>({});

// Lossless mirror of the backend phaseFromState (manager.ts): the persisted
// (autoDisabled + phase + enabled) triple encodes all 7 manager phases.
function phaseFromState(state: AddonState): AddonManagerPhase {
	if (state.autoDisabled) return 'auto_disabled';
	switch (state.phase) {
		case 'active':
			return 'enabled';
		case 'installing':
			return 'enabling';
		case 'disabling':
			return 'disabling';
		case 'error':
			return 'failed';
		default:
			return state.enabled ? 'pending' : 'disabled';
	}
}

// Reflects the SERVER gate (manager.addonCompatibilityError): an add-on that
// declares `compatibleHardware` but excludes the detected board can never enable
// on this device. Absent/empty `compatibleHardware` means all-hardware. Returns
// the human reason, or null when the add-on may run here (or the board is still
// unknown, in which case we never gate).
function incompatibleReason(descriptor: AddonDescriptor, board: string | null): string | null {
	const compatible = descriptor.compatibleHardware;
	if (!compatible || compatible.length === 0) return null;
	if (board === null) return null;
	if ((compatible as readonly string[]).includes(board)) return null;
	const requirement = compatible.join(' or ');
	return `Requires ${requirement} hardware \u2014 this device is ${board}.`;
}

const cards = $derived.by(() => {
	const live = getAddons();
	const board = effectiveHardware;
	return descriptors.map((descriptor) => {
		const state = live[descriptor.id] ?? seedStates[descriptor.id] ?? DEFAULT_STATE;
		return {
			descriptor,
			state,
			phase: phaseFromState(state),
			incompatible: incompatibleReason(descriptor, board),
			hasDocs: Boolean(descriptor.docs) || Boolean(descriptor.helpUrl),
		};
	});
});

onMount(async () => {
	try {
		const result = await rpc.addons.list();
		descriptors = result.addons.map((a) => a.descriptor);
		seedStates = Object.fromEntries(result.addons.map((a) => [a.descriptor.id, a.state]));
	} catch (error) {
		console.error('Failed to load add-ons:', error);
	} finally {
		loaded = true;
	}

	// Resolve the detected board for the compatibility reflection. Best-effort:
	// if it fails, `effectiveHardware` stays null and nothing is gated client-side
	// (the server still rejects an incompatible enable).
	try {
		const hw = await rpc.streaming.getMockHardware();
		effectiveHardware = hw.effectiveHardware;
	} catch (error) {
		console.error('Failed to resolve detected board:', error);
	}
});

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

const ERROR_COPY: Record<string, string> = {
	addon_insufficient_space: 'Not enough free space on the device to install this add-on.',
	addon_enable_failed: "The add-on couldn't be installed. Check the device logs for details.",
	addon_disable_failed: "The add-on couldn't be removed. Check the device logs for details.",
	addon_validation_failed: 'The add-on started but failed its health check, so it was disabled.',
	addon_crash_loop: 'The add-on kept restarting, so it was disabled to protect the device.',
	addon_not_found: 'This add-on is no longer available on the device.',
};

function humanError(code: string | undefined): string | undefined {
	if (!code) return undefined;
	return ERROR_COPY[code] ?? code;
}

// Structured compatibility errors the SERVER raises when an enable is refused by
// the hardware/deps/conflicts gate (manager.addonCompatibilityError). These are
// surfaced INLINE on the card (a pinned warning) rather than as a transient
// toast, so the operator keeps seeing why the add-on can't turn on.
const COMPAT_ERROR_COPY: Record<string, string> = {
	addon_conflict:
		'Conflicts with another enabled add-on. Disable the conflicting add-on first, then try again.',
	addon_dependency_missing: 'A required add-on must be enabled first before this one can turn on.',
	addon_incompatible_hardware: "This add-on isn't compatible with this device's hardware.",
};

function isCompatError(code: string | undefined): code is keyof typeof COMPAT_ERROR_COPY {
	return code !== undefined && code in COMPAT_ERROR_COPY;
}

const PHASE_META = {
	disabled: { label: 'Disabled', badge: 'bg-status-neutral/12 text-status-neutral', busy: false },
	pending: { label: 'Update pending', badge: 'bg-status-info/12 text-status-info', busy: false },
	enabling: { label: 'Installing', badge: 'bg-primary/12 text-primary', busy: true },
	enabled: { label: 'Enabled', badge: 'bg-status-success/15 text-status-success', busy: false },
	disabling: { label: 'Removing', badge: 'bg-status-neutral/12 text-status-neutral', busy: true },
	failed: { label: 'Failed', badge: 'bg-status-error/12 text-status-error', busy: false },
	auto_disabled: {
		label: 'Auto-disabled',
		badge: 'bg-status-warning/15 text-status-warning',
		busy: false,
	},
} as const satisfies Record<AddonManagerPhase, { label: string; badge: string; busy: boolean }>;

function metaLine(descriptor: AddonDescriptor): string {
	const category = descriptor.category.charAt(0).toUpperCase() + descriptor.category.slice(1);
	return `${category} \u00b7 v${descriptor.version}`;
}

function clearActionError(id: string) {
	if (id in actionErrors) {
		const { [id]: _removed, ...rest } = actionErrors;
		actionErrors = rest;
	}
}

// Each add-on enable/disable routes through the keyed async-operation machine
// (key `addon:<id>`, so add-ons toggle independently) for the re-entry guard +
// in-flight `pending` phase. `classify` keeps every resolved verdict `ok` so
// osCommand never emits its generic toast — this surface owns all feedback (calm
// emulated-mode banner, pinned compat warning, or a humanised toast) — and only a
// thrown RPC toasts (via `failMessage`). Every non-applied outcome rejects so the
// pessimistic AsyncSwitch reverts to the prior value.
async function handleToggle(id: string, next: boolean) {
	// A fresh attempt clears any pinned warning from the previous one.
	clearActionError(id);
	const result = await osCommand({
		key: `addon:${id}`,
		target: next,
		rpc: () => (next ? rpc.addons.install({ id }) : rpc.addons.uninstall({ id })),
		confirmOnResolve: true,
		classify: () => ({ ok: true }),
		failMessage: () => 'Add-on action failed.',
	});
	// undefined → re-entry no-op or a thrown RPC (osCommand already toasted).
	if (!result) throw new Error('addon_action_failed');
	if (!result.success) {
		// The op did not apply — drop the optimistically-confirmed async-op entry
		// so it never reads as a real success.
		clearOperation(`addon:${id}`);
		if (result.error === ADDON_UNAVAILABLE_ERROR) {
			unavailable = true;
			// Reject so AsyncSwitch reverts to the prior value without a toast.
			throw new Error(ADDON_UNAVAILABLE_ERROR);
		}
		if (isCompatError(result.error)) {
			// Pin the structured gate reason to the card instead of a transient
			// toast — the enable was blocked by the server, not a flaky failure.
			actionErrors = { ...actionErrors, [id]: result.error };
			throw new Error(result.error);
		}
		toast.error(humanError(result.error) ?? 'Add-on action failed.');
		throw new Error(result.error);
	}
	unavailable = false;
}

function toggleDocs(id: string) {
	docsOpen = { ...docsOpen, [id]: !docsOpen[id] };
}
</script>

<AppDialog
	bind:open
	description="Install and manage optional device features."
	hideFooter
	icon={Blocks}
	title="Add-ons"
>
	<div class="space-y-4" data-testid="addons-section">
		{#if unavailable}
			<div
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
				data-testid="addons-unavailable"
				role="status"
			>
				Add-ons can't be changed in this preview. Connect to a CeraLive device to install or
				remove them.
			</div>
		{/if}

		{#if loaded && cards.length === 0}
			<!-- Empty state: descriptors only exist on a device image that bakes them in. -->
			<div
				class="border-border/70 bg-muted/30 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center"
				data-testid="addons-empty"
			>
				<span class="bg-secondary text-muted-foreground grid size-11 place-items-center rounded-xl">
					<Package class="size-5" />
				</span>
				<div class="space-y-1">
					<p class="text-sm font-semibold">No add-ons available</p>
					<p class="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
						Optional features appear here when your device image includes them.
					</p>
				</div>
			</div>
		{/if}

		{#each cards as card (card.descriptor.id)}
			{@const meta = PHASE_META[card.phase]}
			<div
				class="bg-card space-y-3 rounded-xl border p-4"
				data-addon-id={card.descriptor.id}
				data-addon-phase={card.phase}
				data-testid={`addon-card-${card.descriptor.id}`}
			>
				<div class="flex items-start gap-3">
					<div class="min-w-0 flex-1 space-y-0.5">
						<p class="truncate text-sm font-semibold">{card.descriptor.name}</p>
						<p class="text-muted-foreground truncate text-xs">{metaLine(card.descriptor)}</p>
					</div>
					{#if card.incompatible}
						<!-- Incompatible with the detected board: the toggle is locked and
						     the reason is surfaced on hover/focus (tooltip + native title),
						     mirroring the server's hardware gate. -->
						<Tooltip.Provider>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<span {...props} class="inline-flex items-center" title={card.incompatible}>
											<AsyncSwitch
												aria-label={`Enable ${card.descriptor.name}`}
												checked={card.state.enabled}
												data-testid={`addon-switch-${card.descriptor.id}`}
												disabled
												onCheckedChange={(next) => handleToggle(card.descriptor.id, next)}
											/>
										</span>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content>
									<p class="max-w-[16rem] text-xs leading-relaxed">{card.incompatible}</p>
								</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
					{:else}
						<AsyncSwitch
							aria-label={`Enable ${card.descriptor.name}`}
							checked={card.state.enabled}
							data-testid={`addon-switch-${card.descriptor.id}`}
							disabled={!loaded || meta.busy}
							onCheckedChange={(next) => handleToggle(card.descriptor.id, next)}
						/>
					{/if}
				</div>

				<div class="flex items-center justify-between gap-3">
					<span
						class={cn(
							'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
							meta.badge,
						)}
						data-testid={`addon-badge-${card.descriptor.id}`}
					>
						{#if meta.busy}
							<LoaderCircle class="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
						{:else}
							<span class="size-1.5 rounded-full bg-current"></span>
						{/if}
						{meta.label}
					</span>
					<span class="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-xs">
						<HardDrive class="size-3.5" aria-hidden="true" />
						<span class="tabular-nums">{humanBytes(card.descriptor.artifact.sizeInstalled)}</span>
					</span>
				</div>

				{#if card.phase === 'enabling'}
					<div
						class="bg-primary/10 h-1.5 w-full overflow-hidden rounded-full"
						role="progressbar"
						aria-label="Installing add-on"
					>
						<div class="bg-primary h-full w-1/3 animate-pulse rounded-full motion-reduce:animate-none"></div>
					</div>
				{/if}

				{#if card.phase === 'pending'}
					<p
						class="text-status-info/90 bg-status-info/8 rounded-md px-3 py-2 text-xs leading-relaxed"
						data-testid={`addon-pending-${card.descriptor.id}`}
					>
						Waiting for a compatible update. This add-on stays selected and finishes installing
						after the next system update.
					</p>
				{:else if card.phase === 'auto_disabled'}
					<p
						class="text-status-warning bg-status-warning/8 rounded-md px-3 py-2 text-xs leading-relaxed"
						data-testid={`addon-autodisabled-${card.descriptor.id}`}
					>
						Auto-disabled to protect the device.{#if humanError(card.state.lastError)}
							{' '}{humanError(card.state.lastError)}{/if}
					</p>
				{:else if card.phase === 'failed' && humanError(card.state.lastError)}
					<p
						class="text-status-error bg-status-error/8 rounded-md px-3 py-2 text-xs leading-relaxed"
						data-testid={`addon-error-${card.descriptor.id}`}
					>
						{humanError(card.state.lastError)}
					</p>
				{/if}

				{#if card.incompatible}
					<!-- Always-visible reason: incompatible add-ons are shown disabled
					     WITH the reason, never hidden. -->
					<p
						class="text-status-warning bg-status-warning/8 inline-flex items-start gap-1.5 rounded-md px-3 py-2 text-xs leading-relaxed"
						data-testid={`addon-incompatible-${card.descriptor.id}`}
						role="note"
					>
						<Ban class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span>{card.incompatible}</span>
					</p>
				{/if}

				{#if actionErrors[card.descriptor.id]}
					{@const code = actionErrors[card.descriptor.id]}
					<!-- Pinned warning from the server's structured enable error
					     (conflict / missing dependency). -->
					<p
						class="text-status-warning bg-status-warning/8 inline-flex items-start gap-1.5 rounded-md px-3 py-2 text-xs leading-relaxed"
						data-testid={`addon-conflict-${card.descriptor.id}`}
						role="alert"
					>
						<TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span>{(code && COMPAT_ERROR_COPY[code]) ?? code}</span>
					</p>
				{/if}

				{#if card.hasDocs}
					{@const isOpen = Boolean(docsOpen[card.descriptor.id])}
					<div class="border-border/60 border-t pt-3">
						<button
							class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
							type="button"
							aria-expanded={isOpen}
							aria-controls={`addon-docs-${card.descriptor.id}`}
							data-testid={`addon-docs-toggle-${card.descriptor.id}`}
							onclick={() => toggleDocs(card.descriptor.id)}
						>
							<BookOpen class="size-3.5" aria-hidden="true" />
							{isOpen ? 'Hide help' : 'Help & documentation'}
							<ChevronDown
								class={cn('size-3.5 transition-transform duration-200', isOpen && 'rotate-180')}
								aria-hidden="true"
							/>
						</button>

						{#if isOpen}
							<div
								class="text-muted-foreground mt-2 space-y-2 text-xs leading-relaxed"
								data-testid={`addon-docs-${card.descriptor.id}`}
								id={`addon-docs-${card.descriptor.id}`}
							>
								{#if card.descriptor.docs}
									<p class="whitespace-pre-line">{card.descriptor.docs}</p>
								{/if}
								{#if card.descriptor.helpUrl}
									<a
										class="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 font-medium transition-colors"
										data-testid={`addon-helpurl-${card.descriptor.id}`}
										href={card.descriptor.helpUrl}
										rel="noopener noreferrer"
										target="_blank"
									>
										<ExternalLink class="size-3.5" aria-hidden="true" />
										Open documentation
									</a>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</AppDialog>
