<!--
  SshDialog.svelte — SSH access management (Task 26).

  Shows the current SSH server status, the generated SSH password (masked, with
  copy + show/hide), a reset action, and a start/stop toggle. State is read from
  the live subscriptions surface (getSsh / getConfig). The start/stop toggle is an
  OS op routed through `osCommand` (raw rpc.system.sshStart/sshStop); the password
  reset is a one-shot helper call (resetSSHPasword) with its own success toast.

  TWO INDEPENDENT AXES, and they are deliberately NOT fused. The Start/Stop button
  answers "is SSH running right now"; the boot-persistence switch answers "will it
  come back after a reboot" (`systemctl enable|disable ssh`, never `--now`). Each
  owns its OWN async-operation key, so neither refuses the other and neither moves
  the other's control. Fusing them would remove the ability to run SSH for one
  session without committing it to boot — an explicit owner decision.

  The pairing is also what makes the outage this fixes VISIBLE: a device that is
  `active` but not `enabled` looks perfectly healthy and silently loses SSH on the
  next reboot, so exactly that combination renders a standing advisory band.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import {
	Copy,
	Eye,
	EyeOff,
	LoaderCircle,
	RotateCcw,
	SquareTerminal,
	TriangleAlert,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { resetSSHPasword } from '$lib/helpers/SystemHelper';
import {
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import {
	sshIsActive,
	sshIsPersistent,
	sshToggleConfirmed,
} from '$lib/rpc/os-toggle-predicates';
import { getConfig, getSsh } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const ssh = $derived(getSsh());
const active = $derived(sshIsActive(ssh));
const persisted = $derived(sshIsPersistent(ssh));
const user = $derived(ssh?.user ?? '');
const sshPass = $derived(getConfig()?.ssh_pass ?? '');

// Running now, but nothing will bring it back — the exact silent-outage state.
const persistWarning = $derived(active && !persisted);

let show = $state(false);

// SSH active is a G4 status field — it CANNOT use the dirty-registry/field-sync
// layer, so the toggle routes through the keyed async-operation transient layer.
// Stay `pending` after dispatch; the confirm $effect resolves it once `ssh.active`
// matches the target (the 15 s TTL valve is the backstop).
const busy = $derived(getOperationPhase('ssh') === 'pending');
let toggleTarget = $state<boolean | null>(null);

// Boot persistence runs the SAME G4 machinery under its OWN key, so a pending
// Start/Stop can never refuse it (or move its switch) and vice versa.
const PERSIST_KEY = 'ssh-persist';
const persistBusy = $derived(getOperationPhase(PERSIST_KEY) === 'pending');
let persistTarget = $state<boolean | null>(null);

async function copyPassword() {
	if (!sshPass) return;
	if (await copyToClipboard(sshPass)) {
		toast.success(m["advanced.passwordCopied"](), { description: m["advanced.passwordCopiedDesc"]() });
	} else {
		toast.error(m["advanced.copyFailed"]());
	}
}

async function resetPassword() {
	try {
		const password = await resetSSHPasword();
		if (!password) {
			toast.error(m["osActions.sshResetFailed"]());
			return;
		}
		toast.success(m["advanced.passwordCopied"]());
	} catch (error) {
		console.error('Failed to reset SSH password:', error);
		toast.error(m["osActions.sshResetFailed"]());
	}
}

async function toggle() {
	const target = !active;
	toggleTarget = target;
	await osCommand({
		key: 'ssh',
		target,
		rpc: () => (target ? rpc.system.sshStart() : rpc.system.sshStop()),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

// Confirm the toggle once the live snapshot reports the target SSH state.
$effect(() => {
	if (getOperationPhase('ssh') !== 'pending') return;
	if (sshToggleConfirmed(active, toggleTarget)) {
		confirmOperation('ssh');
	}
});

async function togglePersist(next: boolean) {
	persistTarget = next;
	const result = await osCommand({
		key: PERSIST_KEY,
		target: next,
		rpc: () => rpc.system.sshSetPersistent({ enabled: next }),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
	// undefined → re-entry no-op or a thrown RPC; success:false → already `failed`
	// via defaultClassify. Either way there is no device truth to wait for.
	if (!result?.success) {
		persistTarget = null;
		return;
	}
	// Success: stay `pending`. The confirm $effect below resolves it once the
	// authoritative `ssh.enabled` broadcast reflects the target, so the switch's
	// final position always waits for the device's own answer.
}

$effect(() => {
	if (getOperationPhase(PERSIST_KEY) !== 'pending') return;
	if (sshToggleConfirmed(persisted, persistTarget)) {
		persistTarget = null;
		confirmOperation(PERSIST_KEY);
	}
});
</script>

<AppDialog
	bind:open
	description={m["settings.index.sshDesc"]()}
	hideFooter
	icon={SquareTerminal}
	title={m["settings.index.ssh"]()}
>
	<div class="space-y-5">
		<!-- Service state: the two independent axes, grouped so the relationship
		     between "running now" and "survives a reboot" is legible at a glance. -->
		<div class="space-y-2">
			<!-- Axis 1 — running right now. -->
			<div
				class={cn(
					'flex items-center justify-between rounded-lg border px-4 py-3',
					active ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/40',
				)}
				data-testid="ssh-status-card"
			>
				<div class="flex items-center gap-2.5 text-sm">
					<span
						class={cn(
							'size-2.5 rounded-full',
							active ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground/50',
						)}
					></span>
					<span class="font-medium">{m["advanced.sshServer"]()}</span>
				</div>
				<span
					class={cn(
						'rounded-md px-2.5 py-1 text-xs font-semibold',
						active ? 'bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground',
					)}
				>
					{active ? m["advanced.active"]() : m["advanced.inactive"]()}
				</span>
			</div>

			<!-- Axis 2 — survives a reboot. Pessimistic: the switch position is the
			     device's own `ssh.enabled`, and only the spinner is optimistic. -->
			<div class="overflow-hidden rounded-lg border">
				<div
					class="flex items-center justify-between gap-4 px-4 py-3.5"
					data-testid="ssh-persist-row"
				>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-semibold">{m["advanced.sshPersist"]()}</p>
						<p class="text-muted-foreground mt-0.5 text-xs">{m["advanced.sshPersistHint"]()}</p>
					</div>
					<span class="flex shrink-0 items-center gap-2">
						{#if persistBusy}
							<LoaderCircle
								aria-hidden="true"
								class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
							/>
						{/if}
						<Switch
							aria-label={m["advanced.sshPersist"]()}
							bind:checked={() => persisted, (next) => void togglePersist(next)}
							data-testid="ssh-persist-toggle"
							disabled={persistBusy}
						/>
					</span>
				</div>
			</div>

			<!-- Running, but nothing brings it back: the silent outage, made visible.
			     Amber advisory, never destructive — SSH works right now. -->
			{#if persistWarning}
				<div
					class="border-status-warning/40 bg-status-warning/10 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
					data-testid="ssh-persist-warning"
					role="status"
				>
					<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
					<span>{m["advanced.sshPersistWarning"]()}</span>
				</div>
			{/if}
		</div>

		<!-- Password -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="ssh-password">
				{m["advanced.sshPassword"]({ sshUser: user })}
			</Label>
			<p class="text-muted-foreground text-xs">{m["advanced.sshPasswordTooltip"]()}</p>
			<div class="relative">
				<Input
					id="ssh-password"
					class="pe-20 font-mono"
					placeholder={m["advanced.sshPasswordPlaceholder"]()}
					readonly
					type={show ? 'text' : 'password'}
					value={sshPass}
				/>
				<div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
					<Button
						aria-label={m["advanced.copyToClipboard"]()}
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
						aria-label={show ? m["advanced.hidePassword"]() : m["advanced.showPassword"]()}
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
				{m["advanced.reset"]()}
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
			{active ? m["advanced.stopSSH"]() : m["advanced.startSSH"]()}
		</Button>
	</div>
</AppDialog>
