<!--
  EthernetRoleSelector.svelte — the per-port Uplink / Shared LAN control.

  Five rules carry it, and each one is a rule this repo already wrote down
  somewhere else:

  1. EVERY RUNG STATES ITS CONSEQUENCE, ON SCREEN. A role is not a preference —
     it decides whether the port carries bonded stream traffic or hands itself to
     the client zone — so both sentences are rendered beside their rung rather
     than hidden in a `title` the shipped kiosk touchscreen can never hover to
     reveal.

  2. SELECTION IS STAGED; SAVE IS THE ONLY THING THAT APPLIES. This control
     dispatches NOTHING — it owns no RPC and no async-op — because a role change
     reconfigures the port and can drop the very LAN path the operator is reading
     it over, and a radio button is not consent to that. The rung the operator
     picks is dialog state held by `NetifDialog`, which calls `setEthernetRole`
     from its Save handler and nowhere else.

  3. A STAGED CHANGE IS VISIBLE, AND IT NAMES WHAT IT COSTS. A picked rung looks
     exactly like the rung the device is already on, so a staged role renders a
     standing band (`deriveEthernetRoleStagedWarning`) stating that saving can
     drop LAN connectivity to this device. It stands rather than toasts: the
     shipped kiosk touchscreen cannot hover, and an expiring notice is how a
     pending change comes to read as an applied one.

  4. THE STREAMING INTERLOCK ESCALATES THAT BAND — it is not a second step. Only
     a port that is CURRENTLY a bonded member, while a stream is live, adds the
     "this costs the live stream bandwidth" sentence
     (`deriveEthernetRoleConsequence`). Save already gates the change, so a
     separate arm/confirm would be a confirm on top of a confirm, which is how
     operators learn to click one through without reading it.

  5. THE DEVICE MOVES THE CONTROL, NOT THE SAVE. `setEthernetRole` answers
     `{success:true}` only after NetworkManager has, and the operator-visible
     settlement is the `eth_role` TERMINAL frame — so the op stays `pending`
     after the RPC resolves and the displayed role is held on the PRIOR one. A
     refusal leaves the prior role on screen with the device's own typed reason
     rendered inline.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { EthernetRole } from '@ceraui/rpc/schemas';
import { Loader2, TriangleAlert } from '@lucide/svelte';

import { cn } from '$lib/utils';

import {
	deriveEthernetRoleStagedWarning,
	type EthernetRoleContext,
	ethernetRoleLabelKey,
	type EthernetRoleView,
} from './ethernet-role-view';

interface Props {
	view: EthernetRoleView;
	/** What the port is doing now — decides whether a transition destroys anything. */
	context: EthernetRoleContext;
	/** The role the operator has picked but not yet saved. */
	staged?: EthernetRole | undefined;
	/** Stage a role. The dialog owns the state; this control never dispatches. */
	onSelect: (role: EthernetRole) => void;
}

const { view, context, staged, onSelect }: Props = $props();

// The staged pick outranks the device's own role, so the control shows what
// Save would apply — while `view.displayRole` stays the applied truth the
// warning band and the pending hold are both measured against.
const selectedRole = $derived(staged ?? view.displayRole);

const stagedWarning = $derived(
	deriveEthernetRoleStagedWarning(view.displayRole, staged, context),
);
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
				{@const selected = option.role === selectedRole}
				<button
					aria-checked={selected}
					class={cn(
						'flex w-full min-h-[var(--touch-target-min)] items-start gap-2.5 px-3 py-2.5 text-start transition-colors',
						selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent/50',
						'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
					)}
					data-pending={option.pending}
					data-role={option.role}
					data-selected={selected}
					data-staged={staged === option.role}
					data-testid="eth-role-option-{view.name}-{option.role}"
					disabled={view.pending}
					onclick={() => onSelect(option.role)}
					role="radio"
					type="button"
				>
					<span
						aria-hidden="true"
						class={cn(
							'mt-1 size-2.5 shrink-0 rounded-full border',
							selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
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

		{#if stagedWarning}
			<div
				class="border-status-warning/30 bg-status-warning/10 space-y-1.5 rounded-lg border px-2.5 py-2"
				data-consequence={stagedWarning.consequence ?? ''}
				data-target={stagedWarning.target}
				data-testid="eth-role-staged-{view.name}"
				role="status"
			>
				<p class="text-status-warning text-xs font-semibold">
					{resolveMessageKey(stagedWarning.titleKey)}
				</p>
				<p class="text-muted-foreground text-xs">{resolveMessageKey(stagedWarning.bodyKey)}</p>
				{#if stagedWarning.consequenceBodyKey}
					<!-- The live-bond cost is a SECOND sentence, never a replacement: the
					     reachability warning above is true of every role change, and a
					     bonded port losing the stream bandwidth is true on top of it. -->
					<p
						class="text-muted-foreground text-xs"
						data-testid="eth-role-staged-consequence-{view.name}"
					>
						{resolveMessageKey(stagedWarning.consequenceBodyKey)}
					</p>
				{/if}
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
