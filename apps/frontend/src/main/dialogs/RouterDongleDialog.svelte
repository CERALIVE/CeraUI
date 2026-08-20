<!--
  RouterDongleDialog.svelte — the settings a router-mode dongle actually has.

  A `router-ethernet` dongle runs its own embedded router, so ModemManager can
  say nothing about it and every mmcli-shaped control in ModemConfigDialog would
  be inert. What this dialog offers instead is the intersection of two things:
  what the vendor's own HTTP admin API exposes, and what a write to it was
  OBSERVED to change on real hardware.

  THAT INTERSECTION IS SMALL ON PURPOSE. The backend only publishes
  `router_admin.controls` for a device whose writes were proven by round-trip on
  a bench unit, so this dialog renders toggles for a Huawei HiLink and renders
  NONE for a ZTE MF79U whose firmware accepts every request and applies none of
  them. A device with nothing provably settable gets an honest sentence and the
  address of the vendor UI that does own its configuration — never a disabled
  switch, which would read as a setting the operator merely lacks permission for.

  THE NETWORK-MODE CHIPS ARE THE SAME BARGAIN, ONE LAYER UP. They are pressable
  only when the firmware NAMED its own mode catalog; a firmware that declines the
  question (the bench unit answers error 112008) renders its own refusal, with no
  control at all. The gate is the capability reading itself, never a firmware
  allowlist — and the device re-reads that same capability in the write's own
  cycle before it builds any request document, so the offer and the write cannot
  disagree about what this dongle will discuss.

  APPLY IS PESSIMISTIC, AND HERE THAT IS LITERAL. The switch does not move when
  the operator taps it. It moves when the backend has re-READ the dongle and
  reported the new value back, because the whole reason this surface exists is
  that a control which claims success and changes nothing is worse than no
  control at all. A refusal restores the switch to the device's last known truth
  and says which of the three things went wrong.

  Each control applies on its own — there is no Save. The write is a live HTTP
  round-trip to a device on the far side of a USB link, so batching two of them
  behind one button would only make a slow operation ambiguous about which half
  failed.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { Modem, RouterAdminControls } from '@ceraui/rpc/schemas';
import { ExternalLink, Info, Router } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import { Button } from '$lib/components/ui/button';
import { AppDialog } from '$lib/components/dialogs';
import { Label } from '$lib/components/ui/label';
import { rpc } from '$lib/rpc';

import {
	openRouterAdminUi,
	routerAdminOpenReasonKey,
} from '../network/router-admin-open';
import { detailFields, identityFields, netModeCapability } from './router-dongle-fields';

interface Props {
	open?: boolean;
	deviceId: string;
	modem: Modem;
}

let { open = $bindable(false), deviceId, modem }: Props = $props();

type ControlId = keyof RouterAdminControls;

const admin = $derived(modem.router_admin);
const controls = $derived(admin?.controls);

// The control currently in flight, so its own row shows the wait and its
// SIBLING is locked out — two overlapping writes to one dongle would each open
// their own session against a device that issues single-use tokens.
let pending = $state<ControlId | undefined>(undefined);

// The mode currently being applied. Separate from `pending` because the two
// surfaces are independent writes to one dongle, and a shared slot would let a
// mode chip show the spinner a toggle started.
let pendingMode = $state<string | undefined>(undefined);

/**
 * The value to render for a control.
 *
 * Always the DEVICE's value. There is no local editable copy to drift from it,
 * which is what makes the "switch only moves when the device moved" rule
 * structural rather than a discipline the next edit could forget.
 */
function deviceValue(id: ControlId): boolean {
	return controls?.[id] ?? false;
}

const identity = $derived(identityFields(admin));
const details = $derived(detailFields(admin));
const netMode = $derived(netModeCapability(admin));

async function openAdmin(): Promise<void> {
	const outcome = await openRouterAdminUi(deviceId);
	if (!outcome.ok) {
		toast.error(resolveMessageKey(routerAdminOpenReasonKey(outcome.reason)));
	}
}

function refusalMessage(error: string | undefined): string {
	if (error === 'not_applied') return m["network.routerCellular.control.notApplied"]();
	if (error === 'unreachable') return m["network.routerCellular.control.unreachable"]();
	return m["network.routerCellular.control.unsupported"]();
}

async function apply(control: ControlId, value: boolean) {
	if (pending !== undefined) return;
	pending = control;
	try {
		const result = await rpc.modems.setRouterControl({
			device: deviceId,
			control,
			value,
		});
		if (result.success) {
			toast.success(m["network.os.saved"]());
		} else {
			toast.error(refusalMessage(result.error));
		}
	} catch {
		toast.error(m["network.routerCellular.control.unreachable"]());
	} finally {
		// The switch re-reads `controls` from the broadcast the backend sent after
		// verifying the write, so nothing is assigned here — success and refusal
		// both simply stop waiting and show whatever the device now reports.
		pending = undefined;
	}
}

function netModeRefusalMessage(error: string | undefined, code?: string): string {
	if (error === 'capability_unavailable') {
		return code === undefined
			? m["network.routerCellular.netMode.refusedUnknown"]()
			: m["network.routerCellular.netMode.refused"]({ code });
	}
	if (error === 'not_offered') return m["network.routerCellular.netMode.notOffered"]();
	if (error === 'not_applied') return m["network.routerCellular.control.notApplied"]();
	if (error === 'unreachable') return m["network.routerCellular.control.unreachable"]();
	return m["network.routerCellular.control.unsupported"]();
}

async function applyNetMode(mode: string) {
	if (pendingMode !== undefined || pending !== undefined) return;
	pendingMode = mode;
	try {
		const result = await rpc.modems.setRouterNetMode({ device: deviceId, mode });
		if (result.success) {
			toast.success(m["network.os.saved"]());
		} else {
			toast.error(netModeRefusalMessage(result.error, result.code));
		}
	} catch {
		toast.error(m["network.routerCellular.control.unreachable"]());
	} finally {
		// Nothing is assigned: the chip re-reads `capabilities` from the broadcast
		// the backend sent after PROVING the write, so a refused mode change leaves
		// the device's own current selection marked, not the requested one.
		pendingMode = undefined;
	}
}
</script>

<AppDialog
	description={modem.ifname}
	hideFooter
	icon={Router}
	title={modem.name ?? m["network.view.cellular"]()}
	bind:open
>
	<div class="space-y-6">
		{#if identity.length > 0}
			<!-- Reported, never edited — the NetifDialog rule: an unboxed
			     label-over-value reads as a data row, where a bordered filled one on
			     a settings surface reads as an input the operator could unlock. -->
			<dl class="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="dongle-identity">
				{#each identity as field (field.id)}
					<div class="min-w-0 space-y-0.5">
						<dt class="text-muted-foreground text-xs font-medium">{field.label}</dt>
						<dd class="truncate font-mono text-sm" data-testid={`dongle-identity-${field.id}`}>
							{field.value}
						</dd>
					</div>
				{/each}
			</dl>
		{/if}

		{#if details.length > 0}
			<!-- Reported, never edited — same unboxed treatment as the identity
			     grid above, and a field the dongle did not state has no row at
			     all rather than a dash that would read like a reading. -->
			<div class="space-y-3 border-t pt-5">
				<p class="text-muted-foreground text-xs font-medium">
					{m["network.routerCellular.detailTitle"]()}
				</p>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="dongle-details">
					{#each details as field (field.id)}
						<div class="min-w-0 space-y-0.5">
							<dt class="text-muted-foreground text-xs font-medium">{field.label}</dt>
							<dd class="truncate font-mono text-sm" data-testid={`dongle-detail-${field.id}`}>
								{field.value}
							</dd>
						</div>
					{/each}
				</dl>
			</div>
		{/if}

		{#if netMode}
			<!-- Discovered FIRST, offered second. The reason arm carries NO control of
			     any kind — a firmware that declined to name its catalog says so in its
			     own words (the bench unit's own 112008) rather than being handed a chip
			     that fails on click. Only the reported arm is selectable, and even then
			     the device re-checks the same capability before it writes. -->
			<div class="space-y-3 border-t pt-5" data-testid="dongle-net-mode">
				<div class="space-y-0.5">
					<p class="text-muted-foreground text-xs font-medium">
						{m["network.routerCellular.netMode.title"]()}
					</p>
					<p class="text-muted-foreground/80 text-xs">
						{netMode.selectable
							? m["network.routerCellular.netMode.selectNote"]()
							: m["network.routerCellular.netMode.readOnlyNote"]()}
					</p>
				</div>

				{#if netMode.reason}
					<p class="text-muted-foreground text-xs" data-testid="dongle-net-mode-reason">
						{netMode.reason}
					</p>
				{:else}
					<ul class="flex flex-wrap gap-1.5" data-testid="dongle-net-mode-list">
						{#each netMode.modes as mode (mode.id)}
							<li>
								<button
									class="rounded-md border px-2 py-0.5 font-mono text-xs transition-colors disabled:opacity-60 {mode.current
										? 'border-primary/50 bg-primary/10 text-primary'
										: 'text-muted-foreground hover:border-primary/40 hover:text-foreground'}"
									data-current={mode.current ? 'true' : undefined}
									data-pending={pendingMode === mode.id ? 'true' : undefined}
									data-testid={`dongle-net-mode-${mode.id}`}
									disabled={mode.current || pendingMode !== undefined || pending !== undefined}
									onclick={() => applyNetMode(mode.id)}
									type="button"
								>
									{mode.label}{#if mode.current}<span class="ms-1.5 font-sans"
											>{m["network.routerCellular.netMode.current"]()}</span
										>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if controls}
			<div class="space-y-5 border-t pt-5" data-testid="dongle-controls">
				<div
					class="flex items-start justify-between gap-4"
					data-testid="dongle-control-mobile_data"
					data-checked={deviceValue('mobile_data') ? 'true' : 'false'}
					data-pending={pending === 'mobile_data' ? 'true' : undefined}
				>
					<div class="min-w-0 space-y-0.5">
						<Label class="text-sm font-medium" for="dongle-mobile-data">
							{m["network.routerCellular.control.mobileData"]()}
						</Label>
						<p class="text-muted-foreground text-xs">
							{m["network.routerCellular.control.mobileDataDesc"]()}
						</p>
					</div>
					<LabeledSwitch
						checked={deviceValue('mobile_data')}
						disabled={pending !== undefined}
						label={m["network.routerCellular.control.mobileData"]()}
						onCheckedChange={(v) => apply('mobile_data', v)}
					/>
				</div>

				<div
					class="flex items-start justify-between gap-4"
					data-testid="dongle-control-roaming_autoconnect"
					data-checked={deviceValue('roaming_autoconnect') ? 'true' : 'false'}
					data-pending={pending === 'roaming_autoconnect' ? 'true' : undefined}
				>
					<div class="min-w-0 space-y-0.5">
						<Label class="text-sm font-medium" for="dongle-roaming">
							{m["network.routerCellular.control.roaming"]()}
						</Label>
						<p class="text-muted-foreground text-xs">
							{m["network.routerCellular.control.roamingDesc"]()}
						</p>
					</div>
					<LabeledSwitch
						checked={deviceValue('roaming_autoconnect')}
						disabled={pending !== undefined}
						label={m["network.routerCellular.control.roaming"]()}
						onCheckedChange={(v) => apply('roaming_autoconnect', v)}
					/>
				</div>

				<p class="text-muted-foreground/80 text-xs" data-testid="dongle-controls-note">
					{m["network.routerCellular.control.verifiedNote"]()}
				</p>
			</div>
		{:else}
			<div
				class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-lg border p-3"
				data-testid="dongle-no-controls"
				role="status"
			>
				<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-muted-foreground text-xs">
					{m["network.routerCellular.control.none"]()}
				</p>
			</div>
		{/if}

		{#if admin}
			<!-- The address is stated, and the page it names is reachable through
			     CeraUI's own proxy rather than by linking to it: the operator's
			     browser is not on the dongle's network. The proxy is addressed by
			     `deviceId`, which resolves to an INTERFACE — an address would name
			     both units of an identical pair. -->
			<p class="text-muted-foreground/80 text-xs" data-testid="dongle-admin-note">
				{#if admin.reachable}
					{m["network.routerCellular.adminAt"]({ url: admin.admin_url })}
				{:else}
					{m["network.routerCellular.adminUnreachable"]()}
				{/if}
			</p>
			<Button
				class="w-fit gap-1"
				data-testid="dongle-open-admin"
				size="sm"
				variant="outline"
				onclick={openAdmin}
			>
				<ExternalLink class="size-3.5" aria-hidden="true" />
				{m["network.routerCellular.adminOpen"]()}
			</Button>
		{/if}
	</div>
</AppDialog>
