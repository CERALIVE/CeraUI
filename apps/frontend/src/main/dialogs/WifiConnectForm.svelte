<!--
  WifiConnectForm.svelte — inline password entry + connect action for a new
  (unsaved) secured WiFi network.

  Extracted verbatim from WifiSelectorDialog.svelte's `expanded` block. The parent
  owns the connect/submit logic and the password floor; this component only drives
  the password field UI (reveal toggle, min-length inline error, Enter-to-submit)
  and forwards submit / cancel back to the parent. Identical markup + behaviour.

  Validation
  ----------
  `passwordMin` is the schema-derived floor (WIFI_PASSWORD_MIN = 8), passed in from
  the parent (sourced via ValidationAdapter) — no inline literals here.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Eye, EyeOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';

interface Props {
	/** Schema-derived password floor (WIFI_PASSWORD_MIN). */
	passwordMin: number;
	/** Interface-level connect-in-flight guard — disables submit. */
	ifaceBusy: boolean;
	/** Bound password value (owned by the parent dialog). */
	password: string;
	/** Bound reveal toggle (owned by the parent dialog). */
	showPassword: boolean;
	/** Submit the connect attempt with the current password. */
	onSubmit: () => void;
	/** Cancel and collapse the inline form. */
	onCancel: () => void;
}

let {
	passwordMin,
	ifaceBusy,
	password = $bindable(),
	showPassword = $bindable(),
	onSubmit,
	onCancel,
}: Props = $props();

const tooShort = $derived(password.length > 0 && password.length < passwordMin);
</script>

<div class="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
	<label class="text-muted-foreground text-xs" for="wifi-new-password">
		{$LL.wifiSelector.dialog.introducePassword()}
	</label>
	<div class="relative">
		<Input
			id="wifi-new-password"
			aria-invalid={tooShort}
			class="h-11 pe-11 font-mono"
			onkeydown={(e: KeyboardEvent) => {
				if (e.key === 'Enter') onSubmit();
			}}
			placeholder={$LL.wifiSelector.hotspot.placeholderPassword()}
			type={showPassword ? 'text' : 'password'}
			bind:value={password}
		/>
		<button
			aria-label={showPassword
				? $LL.wifiSelector.accessibility.hidePassword()
				: $LL.wifiSelector.accessibility.showPassword()}
			class="text-muted-foreground hover:text-foreground hover:bg-accent absolute end-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 transition-colors"
			onclick={() => (showPassword = !showPassword)}
			type="button"
		>
			{#if showPassword}
				<EyeOff class="size-4" />
			{:else}
				<Eye class="size-4" />
			{/if}
		</button>
	</div>
	{#if tooShort}
		<p class="text-destructive text-xs" role="alert">
			{$LL.wifiSelector.validation.passwordMinLength()}
		</p>
	{/if}
	<div class="flex justify-end gap-2">
		<Button onclick={onCancel} size="sm" variant="ghost">
			{$LL.wifiSelector.dialog.close()}
		</Button>
		<Button disabled={password.length < passwordMin || ifaceBusy} onclick={onSubmit} size="sm">
			{$LL.wifiSelector.button.connect()}
		</Button>
	</div>
</div>
