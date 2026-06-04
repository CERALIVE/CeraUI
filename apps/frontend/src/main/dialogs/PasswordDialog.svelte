<!--
  PasswordDialog.svelte — set the device LAN/web-interface password (Task 25).

  New password (min 8) + confirmation, validated inline. Saves via the auth RPC
  (rpc.auth.setPassword through the savePassword helper). The fields are purely
  local state, so there is nothing for a server push to clobber.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Eye, EyeOff, KeyRound } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { savePassword } from '$lib/helpers/SystemHelper';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const MIN_LENGTH = 8;

let password = $state('');
let confirm = $state('');
let show = $state(false);
let saving = $state(false);

// Reset the form each time the dialog opens.
let wasOpen = false;
$effect(() => {
	if (open && !wasOpen) {
		password = '';
		confirm = '';
		show = false;
	}
	wasOpen = open;
});

const tooShort = $derived(password.length > 0 && password.length < MIN_LENGTH);
const mismatch = $derived(confirm.length > 0 && confirm !== password);
const canSave = $derived(password.length >= MIN_LENGTH && confirm === password && !saving);

async function save() {
	if (!canSave) return;
	saving = true;
	try {
		await savePassword(password);
		toast.success($LL.advanced.passwordCopied());
		open = false;
	} catch (error) {
		console.error('Failed to set device password:', error);
		toast.error($LL.advanced.copyFailed());
	} finally {
		saving = false;
	}
}
</script>

<AppDialog
	bind:open
	description={$LL.advanced.lanPasswordTooltip()}
	icon={KeyRound}
	onPrimary={save}
	primaryDisabled={!canSave}
	primaryLabel={$LL.advanced.save()}
	closeOnPrimary={false}
	title={$LL.settings.index.devicePassword()}
>
	<div class="space-y-5">
		<!-- New password -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="device-password">
				{$LL.advanced.newPassword()}
			</Label>
			<div class="relative">
				<Input
					id="device-password"
					autocomplete="new-password"
					class="pe-11"
					placeholder={$LL.advanced.newPassword()}
					type={show ? 'text' : 'password'}
					bind:value={password}
				/>
				<Button
					aria-label={show ? $LL.advanced.hidePassword() : $LL.advanced.showPassword()}
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					onclick={() => (show = !show)}
					size="icon"
					type="button"
					variant="ghost"
				>
					{#if show}
						<EyeOff class="size-4" />
					{:else}
						<Eye class="size-4" />
					{/if}
				</Button>
			</div>
			{#if tooShort}
				<p class="text-destructive flex items-center gap-2 text-sm" role="alert">
					<span class="bg-destructive size-1.5 shrink-0 rounded-full"></span>
					{$LL.advanced.minLength()}
				</p>
			{/if}
		</div>

		<!-- Confirm password -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="device-password-confirm">
				{$LL.settings.dialogs.confirmPassword()}
			</Label>
			<Input
				id="device-password-confirm"
				autocomplete="new-password"
				placeholder={$LL.settings.dialogs.confirmPassword()}
				type={show ? 'text' : 'password'}
				bind:value={confirm}
			/>
			{#if mismatch}
				<p class="text-destructive flex items-center gap-2 text-sm" role="alert">
					<span class="bg-destructive size-1.5 shrink-0 rounded-full"></span>
					{$LL.settings.dialogs.passwordsMismatch()}
				</p>
			{/if}
		</div>
	</div>
</AppDialog>
