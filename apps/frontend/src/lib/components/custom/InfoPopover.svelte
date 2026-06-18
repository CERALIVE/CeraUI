<!--
  InfoPopover.svelte — a per-field "?" info affordance (Task 9).

  A small, keyboard- and touch-reachable help button that opens a calm popover
  explaining an option, plus an optional disabled REASON shown distinctly. It is
  the education counterpart to the "coming soon" affordance (Task 12): this one
  explains a runtime-detected constraint ("disabled with reason"), never a future
  feature, so the two never share chrome.

  Accessibility
  -------------
  • The trigger is a real <button> (Tab-reachable; Enter/Space activate it).
  • bits-ui Popover wires `aria-expanded`/`aria-controls` on the trigger and
    `aria-describedby` from the trigger to the panel, and closes on Escape /
    outside-click / focus-out — so the panel is announced and dismissible by
    keyboard alone.
  • The trigger carries an explicit `aria-label` (the bare "?" glyph has no
    accessible name otherwise) and a `title` for pointer hover.
  • Hit target is ≥44px (touch) via padding around the small glyph; the
    layout-mode CSS scales it further on kiosk.

  Reduced motion: the open/close transition is the AppDialog-class animation set,
  which the e-ink freeze + `prefers-reduced-motion` already neutralise globally.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { CircleHelp } from '@lucide/svelte';

import * as Popover from '$lib/components/ui/popover';
import { cn } from '$lib/utils';

interface Props {
	/** Popover heading — the field's friendly name. */
	title: string;
	/** Plain-language explanation of the option. */
	body: string;
	/**
	 * Optional runtime-detected reason the field (or an option in it) is
	 * disabled. Rendered in a distinct band so "disabled with reason" never reads
	 * like a "coming soon" future. Omit when nothing is disabled.
	 */
	reason?: string;
	/**
	 * Accessible label for the trigger. Defaults to a localized "About {title}".
	 */
	ariaLabel?: string;
	/** Stable automation hook on the trigger button. */
	testId?: string;
	class?: string;
}

let { title, body, reason, ariaLabel, testId, class: className }: Props = $props();

const triggerLabel = $derived(ariaLabel ?? $LL.live.education.info({ field: title }));
</script>

<Popover.Root>
	<Popover.Trigger
		aria-label={triggerLabel}
		class={cn(
			'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-2.5 transition-colors outline-hidden focus-visible:ring-2 sm:min-h-0 sm:min-w-0 sm:p-1',
			className,
		)}
		data-testid={testId}
		title={triggerLabel}
		type="button"
	>
		<CircleHelp aria-hidden={true} class="size-4 shrink-0" />
	</Popover.Trigger>
	<Popover.Content align="start" class="max-w-xs">
		<Popover.Header>
			<Popover.Title>{title}</Popover.Title>
		</Popover.Header>
		<Popover.Description class="leading-relaxed">{body}</Popover.Description>
		{#if reason}
			<!-- Distinct from "coming soon": a runtime constraint, not a future. -->
			<div
				class="border-status-warning/30 bg-status-warning/10 mt-1 rounded-md border px-2.5 py-2"
				data-testid="info-popover-reason"
			>
				<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
					{$LL.live.education.reasonLabel()}
				</p>
				<p class="text-foreground/90 mt-0.5 text-sm">{reason}</p>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
