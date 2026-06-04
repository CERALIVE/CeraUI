<!--
  SshDialog.svelte — SSH access management (Task 26).

  Shows the current SSH server status, the generated SSH password (masked, with
  copy + show/hide), a reset action, and a start/stop toggle. State is read from
  the live subscriptions surface (getSsh / getConfig); actions go through the
  system RPC via the SystemHelper wrappers.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Copy, Eye, EyeOff, RotateCcw, SquareTerminal } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { resetSSHPasword, startSSH, stopSSH } from '$lib/helpers/SystemHelper';
import { getConfig, getSsh } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const ssh = $derived(getSsh());
const active = $derived(ssh?.active ?? false);
const user = $derived(ssh?.user ?? '');
const sshPass = $derived(getConfig()?.ssh_pass ?? '');

let show = $state(false);
let busy = $state(false);

async function copyPassword() {
	if (!sshPass) return;
	try {
		await navigator.clipboard.writeText(sshPass);
		toast.success($LL.advanced.passwordCopied(), { description: $LL.advanced.passwordCopiedDesc() });
	} catch (error) {
		console.error('Failed to copy SSH password:', error);
		toast.error($LL.advanced.copyFailed());
	}
}

async function resetPassword() {
	try {
		await resetSSHPasword();
		toast.success($LL.advanced.passwordCopied());
	} catch (error) {
		console.error('Failed to reset SSH password:', error);
		toast.error($LL.advanced.copyFailed());
	}
}

async function toggle() {
	if (busy) return;
	busy = true;
	try {
		await (active ? stopSSH() : startSSH());
	} catch (error) {
		console.error('Failed to toggle SSH:', error);
		toast.error($LL.advanced.copyFailed());
	} finally {
		busy = false;
	}
}
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.sshDesc()}
	hideFooter
	icon={SquareTerminal}
	title={$LL.settings.index.ssh()}
>
	<div class="space-y-5">
		<!-- Server status -->
		<div
			class={cn(
				'flex items-center justify-between rounded-lg border px-4 py-3',
				active ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/40',
			)}
		>
			<div class="flex items-center gap-2.5 text-sm">
				<span
					class={cn(
						'size-2.5 rounded-full',
						active ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground/50',
					)}
				></span>
				<span class="font-medium">{$LL.advanced.sshServer()}</span>
			</div>
			<span
				class={cn(
					'rounded-md px-2.5 py-1 text-xs font-semibold',
					active ? 'bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground',
				)}
			>
				{active ? $LL.advanced.active() : $LL.advanced.inactive()}
			</span>
		</div>

		<!-- Password -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="ssh-password">
				{$LL.advanced.sshPassword({ sshUser: user })}
			</Label>
			<p class="text-muted-foreground text-xs">{$LL.advanced.sshPasswordTooltip()}</p>
			<div class="relative">
				<Input
					id="ssh-password"
					class="pe-20 font-mono"
					placeholder={$LL.advanced.sshPasswordPlaceholder()}
					readonly
					type={show ? 'text' : 'password'}
					value={sshPass}
				/>
				<div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
					<Button
						aria-label={$LL.advanced.copyToClipboard()}
						class="size-8 rounded-md"
						disabled={!sshPass}
						onclick={copyPassword}
						size="icon"
						type="button"
						variant="ghost"
					>
						<Copy class="size-4" />
					</Button>
					<Button
						aria-label={show ? $LL.advanced.hidePassword() : $LL.advanced.showPassword()}
						class="size-8 rounded-md"
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
			</div>
			<Button class="w-full gap-2" onclick={resetPassword} variant="outline">
				<RotateCcw class="size-4" />
				{$LL.advanced.reset()}
			</Button>
		</div>

		<!-- Start / stop -->
		<Button
			class={cn(
				'w-full',
				active
					? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
					: 'bg-primary text-primary-foreground hover:bg-primary/90',
			)}
			disabled={busy}
			onclick={toggle}
		>
			{active ? $LL.advanced.stopSSH() : $LL.advanced.startSSH()}
		</Button>
	</div>
</AppDialog>
