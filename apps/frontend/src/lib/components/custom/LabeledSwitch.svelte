<!--
  LabeledSwitch.svelte — thin presentational wrapper around the shadcn `Switch`
  with a localized ON/OFF state label beside it.

  Purely presentational: no RPC, no field-lock / reconciliation logic. It renders
  the controlled `checked` prop as-is and forwards changes via `onCheckedChange`.
  The text label provides at-a-glance redundancy for the switch position, reading
  the localized `network.view.on` / `network.view.off` strings.

  Touch/kiosk: the whole control + label hit area is ≥44px tall.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { Switch } from '$lib/components/ui/switch';
import * as Tooltip from '$lib/components/ui/tooltip';
import { cn } from '$lib/utils';

interface Props {
	/** Controlled checked state. Bindable; mutated only via `onCheckedChange`. */
	checked: boolean;
	/** Fired with the requested next state when the user toggles the switch. */
	onCheckedChange?: (next: boolean) => void;
	/** Render the control disabled and dim the state label. */
	disabled?: boolean;
	/**
	 * When set, surfaced as the accessible reason via tooltip + `title`. Implies
	 * a disabled-style affordance even on its own; pair with `disabled` to lock.
	 */
	disabledReason?: string;
	/** Accessible label for the switch (`aria-label`). */
	label?: string;
	/** Switch size token, forwarded to the primitive. */
	size?: 'sm' | 'default';
	class?: string;
}

let {
	checked = $bindable(false),
	onCheckedChange,
	disabled = false,
	disabledReason,
	label,
	size = 'default',
	class: className,
}: Props = $props();

const stateLabel = $derived(checked ? $LL.network.view.on() : $LL.network.view.off());
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span
					{...props}
					class={cn('inline-flex min-h-[44px] items-center gap-2', className)}
					title={disabledReason}
				>
					<Switch
						aria-label={label}
						bind:checked
						{disabled}
						{onCheckedChange}
						{size}
					/>
					<span
						class={cn(
							'font-mono text-xs tabular-nums select-none',
							checked ? 'text-foreground' : 'text-muted-foreground',
							disabled && 'opacity-50',
						)}
					>
						{stateLabel}
					</span>
				</span>
			{/snippet}
		</Tooltip.Trigger>
		{#if disabledReason}
			<Tooltip.Content>
				<p class="text-xs">{disabledReason}</p>
			</Tooltip.Content>
		{/if}
	</Tooltip.Root>
</Tooltip.Provider>
