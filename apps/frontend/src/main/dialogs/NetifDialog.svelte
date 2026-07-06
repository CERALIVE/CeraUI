<!--
  NetifDialog.svelte — per-interface configuration dialog (Task 24).

  Opened from NetworkView's Ethernet section "Configure" trigger. Lets the
  operator enable/disable a wired interface and set a static IPv4/IPv6 address
  (or leave blank for DHCP). The IP is validated inline against the canonical
  IP_ADDRESS_REGEX from @ceraui/rpc/schemas before the save is allowed.

  Dirty-field guard: once the operator edits a field, incoming server pushes for
  THAT field are ignored until the dialog is reopened, so in-progress edits are
  never clobbered by live telemetry.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { IP_ADDRESS_REGEX, type NetifEntry } from '@ceraui/rpc/schemas';
import { Network } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { rpc } from '$lib/rpc';
import { isOperationPending, osCommand } from '$lib/rpc/async-operation.svelte';

interface Props {
	open?: boolean;
	name: string;
	iface: NetifEntry | undefined;
}

let { open = $bindable(false), name, iface }: Props = $props();

// Local, editable copies. Initialised on the open edge so the form always
// starts from the live interface state.
let enabled = $state(false);
let ip = $state('');

// Dirty-field guard: per-field flags marking operator-edited fields.
let dirtyEnabled = $state(false);
let dirtyIp = $state(false);
let wasOpen = false;
let saving = $state(false);

$effect(() => {
	// Open edge → reset the form from the current interface, clear dirty flags.
	if (open && !wasOpen) {
		enabled = iface?.enabled ?? false;
		ip = iface?.ip ?? '';
		dirtyEnabled = false;
		dirtyIp = false;
	}
	wasOpen = open;
});

$effect(() => {
	// Live sync while open — but only for fields the operator hasn't touched.
	if (!open) return;
	const serverEnabled = iface?.enabled;
	const serverIp = iface?.ip ?? '';
	if (!dirtyEnabled && serverEnabled !== undefined) enabled = serverEnabled;
	if (!dirtyIp) ip = serverIp;
});

const trimmedIp = $derived(ip.trim());
// Empty IP === DHCP (valid). A non-empty value must match the canonical regex.
const ipValid = $derived(trimmedIp === '' || IP_ADDRESS_REGEX.test(trimmedIp));
const ipInvalid = $derived(trimmedIp !== '' && !ipValid);

// SHARED resource key with BondToggle (both mutate `rpc.network.configure` for
// this interface), so a dialog save and a bond toggle on the same iface can never
// race — the osCommand re-entry guard is also the cross-surface race guard.
const netifKey = $derived(`netif:${name}`);

async function save() {
	if (!ipValid || saving) return;
	// Cross-surface busy guard: a bond toggle (or another save) on THIS iface is
	// in flight — refuse with the standard busy feedback, don't dispatch a second.
	if (isOperationPending(netifKey)) {
		toast.error($LL.network.os.deviceBusy());
		return;
	}
	saving = true;
	// DHCP path must OMIT ip (undefined), never send "" (fails backend regex).
	const result = await osCommand({
		key: netifKey,
		target: { name, enabled },
		confirmOnResolve: true,
		rpc: () =>
			rpc.network.configure({
				name,
				ip: trimmedIp === '' ? undefined : trimmedIp,
				enabled,
			}),
		busyMessage: () => $LL.network.os.deviceBusy(),
		failMessage: () => $LL.network.os.operationFailed(),
	});
	saving = false;
	// success:false / throw are already toasted by osCommand and keep the dialog
	// open with the form value preserved. Only a confirmed success closes it.
	if (result?.success) {
		toast.success($LL.network.os.saved());
		open = false;
	}
}
</script>

<AppDialog
	closeOnPrimary={false}
	description={name}
	icon={Network}
	onPrimary={save}
	primaryDisabled={ipInvalid}
	primaryLabel={$LL.advanced.save()}
	primaryLoading={saving}
	title={$LL.network.view.configure()}
	bind:open
>
	<div class="space-y-6">
		<!-- Enable / disable -->
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0 space-y-0.5">
				<Label class="text-sm font-medium" for="netif-enabled">
					{$LL.settings.dialogs.enableInterface()}
				</Label>
				<p class="text-muted-foreground text-xs">
					{$LL.settings.dialogs.enableInterfaceDesc()}
				</p>
			</div>
			<LabeledSwitch
				checked={enabled}
				label={$LL.settings.dialogs.enableInterface()}
				onCheckedChange={(v) => {
					enabled = v;
					dirtyEnabled = true;
				}}
			/>
		</div>

		<!-- Static IP -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="netif-ip">
				{$LL.settings.dialogs.staticIp()}
			</Label>
			<Input
				id="netif-ip"
				aria-invalid={ipInvalid}
				autocomplete="off"
				inputmode="text"
				oninput={(e) => {
					ip = e.currentTarget.value;
					dirtyIp = true;
				}}
				placeholder={$LL.settings.dialogs.ipPlaceholder()}
				spellcheck={false}
				value={ip}
			/>
			{#if ipInvalid}
				<p class="text-destructive flex items-center gap-2 text-sm" role="alert">
					<span class="bg-destructive size-1.5 shrink-0 rounded-full"></span>
					{$LL.settings.dialogs.ipInvalid()}
				</p>
			{:else}
				<p class="text-muted-foreground text-xs">{$LL.settings.dialogs.dhcpHint()}</p>
			{/if}
		</div>
	</div>
</AppDialog>
