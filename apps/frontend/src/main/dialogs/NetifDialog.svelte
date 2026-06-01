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

import { AppDialog } from '$lib/components/dialogs';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import { setNetif } from '$lib/helpers/NetworkHelper';

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

async function save() {
	if (!ipValid || saving) return;
	saving = true;
	try {
		// DHCP path must OMIT ip (undefined), never send "" (fails backend regex).
		await setNetif(name, trimmedIp === '' ? undefined : trimmedIp, enabled);
		open = false;
	} catch (error) {
		console.error(`Failed to configure interface ${name}:`, error);
		toast.error($LL.network.errors.toggleFailed());
	} finally {
		saving = false;
	}
}
</script>

<AppDialog
	bind:open
	description={name}
	icon={Network}
	onPrimary={save}
	primaryDisabled={ipInvalid || saving}
	primaryLabel={$LL.advanced.save()}
	closeOnPrimary={false}
	title={$LL.network.view.configure()}
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
			<Switch
				id="netif-enabled"
				checked={enabled}
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
				placeholder="192.168.1.50"
				spellcheck={false}
				value={ip}
				oninput={(e) => {
					ip = e.currentTarget.value;
					dirtyIp = true;
				}}
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
