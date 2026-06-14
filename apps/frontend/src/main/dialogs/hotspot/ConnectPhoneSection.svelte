<!--
  ConnectPhoneSection.svelte — "connect your phone" surface inside HotspotDialog
  (#67 Phase-0).

  Calls `wifi.hotspotInfo` (SSID + gateway IP + active flag — NEVER a password,
  guardrail G3) and, when the hotspot is broadcasting, renders the on-device URL
  (`http://<gatewayIp>/`) plus a device-access QR so a phone can open CeraUI after
  joining the hotspot. Captive-portal is image-side and out of scope here, so a
  visible "navigate manually" note replaces it. When the hotspot is off (or no
  gateway is known yet) the section shows a calm "start the hotspot first" prompt
  instead of a broken QR.

  This sits ALONGSIDE the existing WiFi-join QR (live credentials) in
  HotspotDialog — it does not replace or modify it. The two QRs answer different
  questions: "how do I join the hotspot" vs "how do I open the control UI".
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { HotspotInfo } from '@ceraui/rpc/schemas';
import { Smartphone } from '@lucide/svelte';

import { generateDeviceAccessQr } from '$lib/helpers/NetworkHelper';
import { rpc } from '$lib/rpc/client';

// ── Hotspot info (SSID + gateway IP + active flag; no password by contract) ──
let info = $state<HotspotInfo | null>(null);
$effect(() => {
	let cancelled = false;
	rpc.wifi
		.hotspotInfo()
		.then((result) => {
			if (!cancelled) info = result;
		})
		.catch(() => {
			if (!cancelled) info = { ssid: '', gatewayIp: '', isActive: false };
		});
	return () => {
		cancelled = true;
	};
});

// Active = broadcasting AND we know the gateway to point the phone at.
const active = $derived(Boolean(info?.isActive && info.gatewayIp));

// Port 80 is served by the on-device reverse proxy in production, so the URL is
// the bare gateway origin — no port literal (which would be a dev-only artifact).
const deviceUrl = $derived(active ? `http://${info?.gatewayIp}/` : '');

// ── Device-access QR encodes the URL only — never a credential ──
let qrDataUrl = $state('');
$effect(() => {
	if (!deviceUrl) {
		qrDataUrl = '';
		return;
	}
	generateDeviceAccessQr(deviceUrl)
		.then((url) => {
			qrDataUrl = url;
		})
		.catch(() => {
			qrDataUrl = '';
		});
});
</script>

<div class="space-y-2" data-testid="connect-phone-section">
	<div class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
		<Smartphone class="size-3.5" />
		<span>{$LL.network.hotspot.connectPhoneTitle()}</span>
	</div>

	{#if active}
		<div class="bg-muted/40 flex flex-col items-center gap-3 rounded-lg border p-4">
			<p class="text-muted-foreground text-center text-xs">
				{$LL.network.hotspot.connectPhoneInstructions()}
			</p>

			{#if qrDataUrl}
				<img
					class="size-40 rounded-md bg-white p-2"
					alt={$LL.network.hotspot.deviceAccessQrLabel()}
					data-testid="device-access-qr"
					src={qrDataUrl}
				/>
			{/if}

			<!-- dir="ltr": the URL is always Latin/ASCII; never mirror it under RTL. -->
			<a
				class="text-primary text-sm font-medium underline-offset-4 hover:underline"
				data-testid="device-access-url"
				dir="ltr"
				href={deviceUrl}
				rel="noreferrer"
				target="_blank"
			>
				{deviceUrl}
			</a>

			<p
				class="text-muted-foreground text-center text-xs"
				data-testid="navigate-manually-note"
			>
				{$LL.network.hotspot.navigateManuallyNote()}
			</p>
		</div>
	{:else}
		<div
			class="bg-muted/40 text-muted-foreground rounded-lg border px-3 py-4 text-center text-xs"
			data-testid="hotspot-off-prompt"
		>
			{$LL.network.hotspot.hotspotOffPrompt()}
		</div>
	{/if}
</div>
