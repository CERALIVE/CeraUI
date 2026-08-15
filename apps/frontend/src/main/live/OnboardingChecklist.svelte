<!--
  OnboardingChecklist.svelte — first-run "get set up" guidance for the Live
  destination (T13).

  A calm, dismissible checklist that guides Network → Server → Start and checks
  each step off from existing config/state (the parent passes the derived booleans
  — this component owns no data subscriptions). It COMPLEMENTS the empty-state
  hero: the hero is the focused "choose a destination" CTA; this is the broader
  orientation a first-run operator sees, and it auto-hides once both config steps
  are done.

  e-ink safety: the reveal uses `einkGatedSlide`, which collapses to a css-less
  zero-duration config under the e-ink/mono display profiles (no WAAPI motion on
  e-paper). Touch safety: every control meets the 44px minimum tap target.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Check, ChevronRight, Radio, Rocket, Server, X } from '@lucide/svelte';
import type { Component } from 'svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { einkGatedSlide as slide } from '$lib/transitions';
import { cn } from '$lib/utils';

interface Props {
	networkDone: boolean;
	serverDone: boolean;
	startDone: boolean;
	onConfigureNetwork: () => void;
	onConfigureServer: () => void;
	onDismiss: () => void;
}

const {
	networkDone,
	serverDone,
	startDone,
	onConfigureNetwork,
	onConfigureServer,
	onDismiss,
}: Props = $props();


interface Step {
	id: 'network' | 'server' | 'start';
	icon: Component;
	title: string;
	hint: string;
	done: boolean;
	/** Actionable config steps carry a label + handler; Start is informational. */
	action?: { label: string; onClick: () => void };
}

const steps = $derived<Step[]>([
	{
		id: 'network',
		icon: Radio,
		title: m["live.onboarding.steps.network.title"](),
		hint: m["live.onboarding.steps.network.hint"](),
		done: networkDone,
		action: { label: m["live.onboarding.steps.network.action"](), onClick: onConfigureNetwork },
	},
	{
		id: 'server',
		icon: Server,
		title: m["live.onboarding.steps.server.title"](),
		hint: m["live.onboarding.steps.server.hint"](),
		done: serverDone,
		action: { label: m["live.onboarding.steps.server.action"](), onClick: onConfigureServer },
	},
	{
		id: 'start',
		icon: Rocket,
		title: m["live.onboarding.steps.start.title"](),
		hint: m["live.onboarding.steps.start.hint"](),
		done: startDone,
	},
]);
</script>

<div transition:slide data-testid="live-onboarding">
	<Card.Root>
		<Card.Content class="space-y-4 p-5 sm:p-6">
			<div class="flex items-start gap-3">
				<div class="min-w-0 flex-1 space-y-1">
					<h2 class="text-base font-semibold">{m["live.onboarding.title"]()}</h2>
					<p class="text-muted-foreground text-sm">{m["live.onboarding.subtitle"]()}</p>
				</div>
				<button
					type="button"
					class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 grid size-11 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
					aria-label={m["live.onboarding.dismiss"]()}
					onclick={onDismiss}
				>
					<X aria-hidden={true} class="size-4" />
				</button>
			</div>

			<ol class="space-y-2.5">
				{#each steps as step (step.id)}
					{@const StepIcon = step.icon}
					<li
						class={cn(
							'flex items-center gap-3.5 rounded-xl border px-3.5 py-3 transition-colors',
							step.done ? 'border-primary/30 bg-primary/5' : 'bg-card',
						)}
						data-testid={`onboarding-step-${step.id}`}
						data-complete={step.done}
					>
						<span
							class={cn(
								'grid size-9 shrink-0 place-items-center rounded-lg',
								step.done
									? 'bg-primary text-primary-foreground'
									: 'bg-secondary text-foreground',
							)}
						>
							{#if step.done}
								<Check aria-hidden={true} class="size-[18px]" />
							{:else}
								<StepIcon aria-hidden={true} class="size-[18px]" />
							{/if}
						</span>

						<span class="min-w-0 flex-1">
							<span class="block text-sm font-semibold">{step.title}</span>
							<span class="text-muted-foreground block text-xs">{step.hint}</span>
						</span>

						{#if step.done}
							<span class="text-primary shrink-0 text-xs font-medium">{m["live.onboarding.done"]()}</span>
						{:else if step.action}
							<Button
								class="min-h-11 shrink-0 gap-1.5"
								variant="outline"
								onclick={step.action.onClick}
							>
								{step.action.label}
								<ChevronRight aria-hidden={true} class="size-4 rtl:-scale-x-100" />
							</Button>
						{/if}
					</li>
				{/each}
			</ol>
		</Card.Content>
	</Card.Root>
</div>
