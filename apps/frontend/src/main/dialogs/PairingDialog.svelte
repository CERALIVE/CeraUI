<!--
  PairingDialog.svelte — device claim-code pairing surface (Task 20).

  The dedicated Settings entry that drives the already-wired pairing backend
  (`pairing.generateClaimCode` / `pairing.completePairing`) through the
  `PairingController` store. It composes AppDialog (shared dialog chrome) and
  owns only the body + state-driven affordances:

    • idle      → a single "Generate claim code" call to action.
    • active    → the human-typeable code, a live countdown to `validUntil`, and
                  Complete / Regenerate actions. When the window elapses the code
                  auto-regenerates (decision = pure `shouldAutoRegenerate`).
    • pairing   → the Complete button shows an in-flight spinner.
    • paired    → the bound device id + subscription standing badge (tone from
                  pure `subscriptionTone`).
    • error     → a stable failure message + a Regenerate retry.

  All result-state mapping lives in `pairing-result.ts` (unit-tested); this
  component is the thin runes + markup wiring around it. AppDialog renders the
  single Close footer — every action is in the body so it can be state-specific.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { SubscriptionStatus } from '@ceraui/rpc/schemas';
import { BadgeCheck, CircleCheck, Link2, Loader2, RefreshCw } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { PairingController } from '$lib/pairing/pairing.svelte';
import {
	shouldAutoRegenerate,
	subscriptionTone,
	type SubscriptionTone,
} from '$lib/pairing/pairing-result';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const t = $derived($LL.settings.pairing);

// Each dialog instance owns its own controller (state + countdown ticker).
const pairing = new PairingController();

// Open/close lifecycle: run the validity-window ticker while open; tear it down
// and clear all state on close so a re-open starts from idle.
$effect(() => {
	if (open) {
		pairing.startCountdown();
	} else {
		pairing.stopCountdown();
		pairing.reset();
	}
});

// Regenerate-on-expiry. The pure decision (`shouldAutoRegenerate`) fires only
// for a live `active` code whose window has elapsed; generate() then flips the
// state back to `active` with a fresh window, so this effect cannot loop.
$effect(() => {
	if (shouldAutoRegenerate(pairing.status, pairing.expired)) {
		void generate();
	}
});

async function generate(): Promise<void> {
	try {
		await pairing.generate();
	} catch {
		toast.error(t.generateFailed());
	}
}

async function complete(): Promise<void> {
	try {
		const result = await pairing.complete();
		if (result?.paired) {
			toast.success(t.pairedToast());
		} else if (result) {
			toast.error(t.pairFailed());
		}
	} catch {
		toast.error(t.pairFailed());
	}
}

// Subscription standing → semantic badge classes (tone from the pure reducer).
const TONE_CLASS: Record<SubscriptionTone, string> = {
	positive: 'bg-primary/10 text-primary',
	neutral: 'bg-secondary text-muted-foreground',
	warning: 'bg-status-warning/10 text-status-warning',
	critical: 'bg-destructive/10 text-destructive',
};

function subscriptionLabel(status: SubscriptionStatus): string {
	switch (status) {
		case 'ACTIVE':
			return t.statusActive();
		case 'FREE':
			return t.statusFree();
		case 'EXPIRED':
			return t.statusExpired();
		case 'CANCELLED':
			return t.statusCancelled();
	}
}

const subStatus = $derived(pairing.subStatus);
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.pairingDesc()}
	icon={Link2}
	title={$LL.settings.index.pairing()}
>
	<div class="space-y-5" data-testid="device-pairing">
		{#if pairing.status === 'paired'}
			<!-- Paired: confirmation + subscription standing + bound device id. -->
			<div class="space-y-4 text-center">
				<span
					class="bg-primary/10 text-primary mx-auto grid size-14 place-items-center rounded-full"
				>
					<BadgeCheck class="size-7" />
				</span>
				<div class="space-y-1">
					<p class="text-base font-semibold" data-testid="pairing-status">{t.paired()}</p>
					<p class="text-muted-foreground mx-auto max-w-sm text-sm">{t.pairedBody()}</p>
				</div>

				<dl class="divide-border bg-muted/40 divide-y overflow-hidden rounded-lg border text-start">
					{#if subStatus}
						<div class="flex items-center justify-between gap-4 px-4 py-3">
							<dt class="text-muted-foreground text-sm">{t.subscriptionLabel()}</dt>
							<dd>
								<span
									class={cn(
										'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold',
										TONE_CLASS[subscriptionTone(subStatus)],
									)}
									data-testid="pairing-sub-status"
								>
									<CircleCheck class="size-3.5" />
									{subscriptionLabel(subStatus)}
								</span>
							</dd>
						</div>
					{/if}
					{#if pairing.deviceId}
						<div class="flex items-center justify-between gap-4 px-4 py-3">
							<dt class="text-muted-foreground text-sm">{t.deviceLabel()}</dt>
							<dd class="font-mono text-sm font-medium" data-testid="pairing-device-id">
								{pairing.deviceId}
							</dd>
						</div>
					{/if}
				</dl>
			</div>
		{:else if pairing.code}
			<!-- Active code: display, live countdown, complete + regenerate. -->
			<div class="space-y-3">
				<p class="text-muted-foreground text-xs">{t.codeLabel()}</p>
				<div
					class="bg-background rounded-md border px-4 py-3 text-center font-mono text-3xl font-bold tracking-[0.3em]"
					data-testid="claim-code"
				>
					{pairing.code}
				</div>

				{#if pairing.expired}
					<p class="text-status-warning flex items-center gap-1.5 text-xs" data-testid="claim-code-expiry">
						<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
						{t.regenerating()}
					</p>
				{:else}
					<p class="text-muted-foreground text-xs" data-testid="claim-code-expiry">
						{t.validFor()}
						<span class="text-foreground font-mono font-medium">{pairing.remainingLabel}</span>
					</p>
				{/if}

				<p class="text-muted-foreground text-xs">{t.instructions()}</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button
					disabled={pairing.status === 'pairing' || pairing.expired}
					onclick={complete}
					size="sm"
					data-testid="complete-pairing"
				>
					{#if pairing.status === 'pairing'}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
						{t.waiting()}
					{:else}
						{t.complete()}
					{/if}
				</Button>
				<Button
					disabled={pairing.status === 'generating'}
					onclick={generate}
					size="sm"
					variant="outline"
					data-testid="regenerate-claim-code"
				>
					<RefreshCw class="size-4" />
					{t.regenerate()}
				</Button>
			</div>
		{:else if pairing.status === 'error'}
			<!-- Error: stable failure message + retry. -->
			<div class="space-y-3">
				<p class="text-destructive text-sm" data-testid="pairing-error">{t.pairFailed()}</p>
				<Button onclick={generate} size="sm" data-testid="generate-claim-code">
					<RefreshCw class="size-4" />
					{t.regenerate()}
				</Button>
			</div>
		{:else}
			<!-- Idle: a single call to action to mint the first code. -->
			<div class="space-y-4">
				<div class="flex items-start gap-3">
					<span
						class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg"
					>
						<Link2 class="size-[18px]" />
					</span>
					<p class="text-muted-foreground text-sm">{t.instructions()}</p>
				</div>
				<Button
					disabled={pairing.status === 'generating'}
					onclick={generate}
					data-testid="generate-claim-code"
				>
					{#if pairing.status === 'generating'}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{/if}
					{t.generate()}
				</Button>
			</div>
		{/if}
	</div>
</AppDialog>
