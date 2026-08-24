<!--
  EthernetRoleSelector.svelte — the per-port Uplink / Shared LAN control.

  Four rules carry it, and each one is a rule this repo already wrote down
  somewhere else:

  1. EVERY RUNG STATES ITS CONSEQUENCE, ON SCREEN. A role is not a preference —
     it decides whether the port carries bonded stream traffic or hands itself to
     the client zone — so both sentences are rendered beside their rung rather
     than hidden in a `title` the shipped kiosk touchscreen can never hover to
     reveal.

  2. THE DEVICE MOVES THE CONTROL, NOT THE CLICK. `setEthernetRole` answers
     `{success:true}` only after NetworkManager has, and the operator-visible
     settlement is the `eth_role` TERMINAL frame — so the op stays `pending` after
     the RPC resolves (no `confirmOnResolve`) and the displayed role is held on
     the PRIOR one. A refusal therefore leaves the prior role selected with the
     device's own typed reason rendered inline (`silent: true`, never toast-only).
     Both frame shapes are handled by construction: an admitted transition
     publishes pending→terminal, and the already-applied branch publishes its
     terminal DIRECTLY — the op is begun by `osCommand` before the dispatch, so a
     terminal that arrives with no pending frame still lands on a pending op.

  3. A DESTRUCTIVE TRANSITION IS CONFIRMED INLINE, NOT IN A MODAL. This control
     renders inside `NetifDialog`, which is already portalled; a modal there puts
     the consequence on a layer a touchscreen must dismiss before it can re-read
     what it is confirming. Arming the confirm dispatches nothing.

  4. THE INTERLOCK IS NARROW. Only a port that is CURRENTLY a bonded member,
     while a stream is live, asks — see `deriveEthernetRoleConsequence`.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { EthernetRole } from '@ceraui/rpc/schemas';
import { Loader2, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import {
	deriveEthernetRoleConsequence,
	type EthernetRoleContext,
	ethernetRoleConsequenceKeys,
	ethernetRoleLabelKey,
	ethernetRoleOpKey,
	type EthernetRoleView,
} from './ethernet-role-view';

interface Props {
	view: EthernetRoleView;
	/** What the port is doing now — decides whether a transition destroys anything. */
	context: EthernetRoleContext;
}

const { view, context }: Props = $props();

/** The role an inline confirm is armed for. Arming dispatches nothing. */
let armed = $state<EthernetRole | undefined>(undefined);

const armedConsequence = $derived(
	armed === undefined
		? undefined
		: deriveEthernetRoleConsequence(view.displayRole, armed, context),
);

async function apply(role: EthernetRole) {
	armed = undefined;
	await osCommand({
		key: ethernetRoleOpKey(view.name),
		target: role,
		rpc: () => rpc.network.setEthernetRole({ name: view.name, role }),
		// The reason renders inline beneath the control; a toast would say the
		// same thing twice and then take it away.
		silent: true,
	});
}

function request(role: EthernetRole) {
	if (role === view.displayRole) return;
	if (deriveEthernetRoleConsequence(view.displayRole, role, context) !== undefined) {
		armed = role;
		return;
	}
	void apply(role);
}
</script>

{#if view.supported}
	<div
		class="space-y-2"
		data-name={view.name}
		data-role={view.displayRole}
		data-testid="eth-role-selector"
	>
		<div class="space-y-0.5">
			<p class="text-sm font-medium">{m["network.ethRole.label"]()}</p>
			<p class="text-muted-foreground text-xs">{m["network.ethRole.description"]()}</p>
		</div>

		<!-- One well, two rungs, one divider: the two roles are the two halves of a
		     single decision, and spreading them apart reads as two unrelated facts. -->
		<div
			aria-label={m["network.ethRole.label"]()}
			class="divide-border bg-muted/40 divide-y overflow-hidden rounded-lg border"
			role="radiogroup"
		>
			{#each view.options as option (option.role)}
				<button
					aria-checked={option.selected}
					class={cn(
						'flex w-full min-h-[var(--touch-target-min)] items-start gap-2.5 px-3 py-2.5 text-start transition-colors',
						option.selected
							? 'bg-primary/10 text-primary'
							: 'text-foreground hover:bg-accent/50',
						'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
					)}
					data-pending={option.pending}
					data-role={option.role}
					data-selected={option.selected}
					data-testid="eth-role-option-{view.name}-{option.role}"
					disabled={view.pending}
					onclick={() => request(option.role)}
					role="radio"
					type="button"
				>
					<span
						aria-hidden="true"
						class={cn(
							'mt-1 size-2.5 shrink-0 rounded-full border',
							option.selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
						)}
					></span>
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-1.5 text-sm font-medium">
							{resolveMessageKey(ethernetRoleLabelKey(option.role))}
							{#if option.pending}
								<Loader2 class="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
							{/if}
						</span>
						<!-- The one-line consequence. Rendered for BOTH rungs, always: the
						     operator has to read what a role costs before choosing it. -->
						<span
							class="text-muted-foreground mt-0.5 block text-xs"
							data-testid="eth-role-consequence-{view.name}-{option.role}"
						>
							{resolveMessageKey(option.consequenceKey)}
						</span>
					</span>
				</button>
			{/each}
		</div>

		{#if view.pending && view.pendingTarget}
			<p
				class="text-muted-foreground text-xs"
				data-target={view.pendingTarget}
				data-testid="eth-role-pending-{view.name}"
				role="status"
			>
				{m["network.ethRole.pending"]({
					role: resolveMessageKey(ethernetRoleLabelKey(view.pendingTarget)),
				})}
			</p>
		{/if}

		{#if armed && armedConsequence}
			{@const keys = ethernetRoleConsequenceKeys(armedConsequence)}
			<div
				class="border-status-warning/30 bg-status-warning/10 space-y-2 rounded-lg border px-2.5 py-2"
				data-consequence={armedConsequence}
				data-target={armed}
				data-testid="eth-role-confirm-{view.name}"
				role="status"
			>
				<p class="text-status-warning text-xs font-semibold">
					{resolveMessageKey(keys.title)}
				</p>
				<p class="text-muted-foreground text-xs">{resolveMessageKey(keys.body)}</p>
				<div class="flex flex-wrap gap-2">
					<Button
						class="h-8 min-h-[var(--touch-target-min)] px-2.5"
						data-testid="eth-role-confirm-apply-{view.name}"
						onclick={() => armed && apply(armed)}
						size="sm"
						variant="destructive"
					>
						{resolveMessageKey(keys.confirm)}
					</Button>
					<Button
						class="h-8 min-h-[var(--touch-target-min)] px-2.5"
						data-testid="eth-role-confirm-cancel-{view.name}"
						onclick={() => (armed = undefined)}
						size="sm"
						variant="secondary"
					>
						{m["dialog.cancel"]()}
					</Button>
				</div>
			</div>
		{/if}

		{#if view.errorKey}
			<div
				class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
				data-error={view.error}
				data-testid="eth-role-error-{view.name}"
				role="status"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
				<div class="min-w-0">
					<p class="text-status-warning text-xs font-semibold">
						{m["network.ethRole.error.title"]()}
					</p>
					<p class="text-muted-foreground mt-0.5 text-xs">
						{resolveMessageKey(view.errorKey)}
					</p>
				</div>
			</div>
		{/if}
	</div>
{/if}
