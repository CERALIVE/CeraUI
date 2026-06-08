<!--
  async-switch.svelte — pending-guarded wrapper around the shadcn `Switch`.

  Pessimistic by design: the control NEVER updates its visual state optimistically.
  It renders the controlled `checked` prop as-is and calls `onCheckedChange(next)`,
  only resolving the new state once the caller's RPC settles. While a call is
  in-flight the switch is disabled (built-in `data-disabled:opacity-50`) and a
  subtle spinner appears, re-entrant clicks are ignored (no double-RPC), and on
  rejection the control re-enables while `checked` stays on its prior value.

  The single-flight guard lives in `./async-switch.ts` (`guardedToggle`) so it is
  unit-testable without mounting a component.
-->
<script lang="ts">
import { LoaderCircle } from '@lucide/svelte';

import { Switch } from '$lib/components/ui/switch';
import { cn } from '$lib/utils';

import { guardedToggle, type PendingRef } from './async-switch';

interface Props {
	/** Authoritative checked state. Controlled — mutated only via `onCheckedChange`. */
	checked: boolean;
	/**
	 * Async commit handler. Resolve to confirm the new value, reject to revert.
	 * Re-entrant calls are ignored while one is in-flight.
	 */
	onCheckedChange: (newVal: boolean) => Promise<void>;
	/** Disable the control independently of the in-flight pending lock. */
	disabled?: boolean;
	'data-testid'?: string;
	id?: string;
	'aria-label'?: string;
	class?: string;
}

let {
	checked,
	onCheckedChange,
	disabled = false,
	'data-testid': testid,
	id,
	'aria-label': ariaLabel,
	class: className,
}: Props = $props();

let pending = $state(false);
const pendingRef: PendingRef = {
	get: () => pending,
	set: (value) => {
		pending = value;
	},
};

function handleChange(next: boolean) {
	void guardedToggle(next, onCheckedChange, pendingRef, (error) => {
		console.error('AsyncSwitch onCheckedChange failed:', error);
	});
}
</script>

<span class={cn('relative inline-flex items-center gap-2', className)}>
	<Switch
		{id}
		aria-busy={pending}
		aria-label={ariaLabel}
		bind:checked={() => checked, (next) => handleChange(next)}
		data-testid={testid}
		disabled={disabled || pending}
	/>
	{#if pending}
		<LoaderCircle
			class="text-muted-foreground size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
			aria-hidden={true}
		/>
	{/if}
</span>
