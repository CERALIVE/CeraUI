<!--
  AppDialog.svelte — the canonical shared dialog chrome for CeraUI.

  This is the explicitly-planned dialog abstraction that every settings /
  configuration dialog (Tasks 25-27 and beyond) composes on top of. It owns the
  responsive shell, accessibility, and footer-action contract so individual
  dialogs only supply their body content.

  Behaviour
  ----------
  • Responsive: renders as a centered Dialog under "desktop chrome" and as a
    bottom Sheet (drawer) otherwise. Desktop chrome = `lg` (≥1024px) OR a short
    landscape panel (≥768px wide ∧ ≤600px tall) — see `$lib/layout`'s
    DESKTOP_CHROME_QUERY. The latter case is the kiosk touchscreen (e.g. 800×480):
    a bottom Sheet there is unusable with the on-screen keyboard raised, so it
    gets the centered Dialog (which the `@media (max-height: 500px)` rule in
    app.css collapses to a full-height scrollable form). The breakpoint is
    reactive — resizing across it re-renders the correct surface, preserving `open`.
  • Chrome: sticky header (title + optional icon + description + close button),
    scrollable body, optional pinned footer.
  • Close affordances: ESC, overlay click, and the header close button — all
    provided by the underlying bits-ui Dialog primitive (focus is trapped while
    open and restored on close).
  • RTL: the close button is pinned to the inline-END edge (`end-3`), so it sits
    on the right in LTR and the left in RTL. Footer buttons follow `dir` flow.
  • Destructive: when `destructive` is set, the default primary button uses the
    `destructive` variant (`bg-destructive`).
  • Reduced motion: enter/exit animation is suppressed under
    `prefers-reduced-motion: reduce`.

  API
  ----
  open            (bindable) — controls visibility.
  title           string     — required, drives the accessible name.
  description?    string     — supporting line under the title.
  icon?           Component  — optional Lucide icon shown beside the title.
  destructive?    boolean    — style the default primary action as destructive.
  children        Snippet    — the dialog body (scrollable region).
  actions?        Snippet    — custom footer; overrides the default buttons.
  hideFooter?     boolean    — render no footer at all.
  onPrimary?      () => void — primary (save/confirm) handler; when set, default
                               footer shows primary + cancel buttons.
  primaryLabel?   string     — primary button text (default: dialogs.save).
  primaryDisabled? boolean   — disable the primary button.
  primaryLoading? boolean    — show an in-flight spinner on the primary button and
                               disable it while an RPC is awaiting (additive; off by default).
  secondaryLabel? string     — cancel/close button text.
  onSecondary?    () => void — cancel handler.
  closeOnPrimary? boolean    — close after `onPrimary` (default: true).
  contentClass?   string     — extra classes merged onto the surface.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Dialog as DialogPrimitive } from 'bits-ui';
import Loader2 from '@lucide/svelte/icons/loader-2';
import XIcon from '@lucide/svelte/icons/x';
import type { Component, Snippet } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import * as Dialog from '$lib/components/ui/dialog';
import * as Sheet from '$lib/components/ui/sheet';
import { DESKTOP_CHROME_QUERY } from '$lib/layout';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	title: string;
	description?: string;
	icon?: Component;
	destructive?: boolean;
	children?: Snippet;
	actions?: Snippet;
	hideFooter?: boolean;
	onPrimary?: () => void;
	primaryLabel?: string;
	primaryDisabled?: boolean;
	primaryLoading?: boolean;
	secondaryLabel?: string;
	onSecondary?: () => void;
	closeOnPrimary?: boolean;
	contentClass?: string;
}

let {
	open = $bindable(false),
	title,
	description,
	icon,
	destructive = false,
	children,
	actions,
	hideFooter = false,
	onPrimary,
	primaryLabel,
	primaryDisabled = false,
	primaryLoading = false,
	secondaryLabel,
	onSecondary,
	closeOnPrimary = true,
	contentClass,
}: Props = $props();

// Desktop chrome => centered Dialog; mobile (narrow/tall) => bottom Sheet.
// Short landscape kiosk panels (≥768px ∧ ≤600px tall) count as desktop chrome
// so the dialog stays usable with the on-screen keyboard. See $lib/layout.
const isDesktop = new MediaQuery(DESKTOP_CHROME_QUERY);

const Icon = $derived(icon);

function handlePrimary() {
	if (primaryLoading) return;
	onPrimary?.();
	if (closeOnPrimary) open = false;
}

function handleCancel() {
	onSecondary?.();
	open = false;
}

const surfaceClass = cn(
	'flex max-h-[85svh] w-full flex-col gap-0 overflow-hidden p-0',
	'motion-reduce:animate-none motion-reduce:transition-none',
);
</script>

{#snippet body()}
	<!-- Header -->
	<div
		class="bg-card relative flex shrink-0 flex-col gap-1.5 border-b px-5 py-4 pe-14"
		data-app-dialog-header
	>
		<DialogPrimitive.Title class="flex items-center gap-2.5 text-base leading-tight font-semibold">
			{#if Icon}
				<Icon class="text-primary size-5 shrink-0" />
			{/if}
			<span class="min-w-0 truncate">{title}</span>
		</DialogPrimitive.Title>
		{#if description}
			<DialogPrimitive.Description class="text-muted-foreground text-sm leading-relaxed">
				{description}
			</DialogPrimitive.Description>
		{/if}

		<!-- Close button: pinned to the inline-end edge (right in LTR, left in RTL). -->
		<DialogPrimitive.Close>
			{#snippet child({ props })}
				<Button
					{...props}
					aria-label={$LL.dialogs.close()}
					class="absolute end-3 top-3.5 size-8 rounded-md"
					size="icon"
					variant="ghost"
				>
					<XIcon class="size-4" />
				</Button>
			{/snippet}
		</DialogPrimitive.Close>
	</div>

	<!-- Body (scrollable) -->
	<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
		{@render children?.()}
	</div>

	<!-- Footer -->
	{#if !hideFooter}
		<div
			class="bg-muted/40 flex shrink-0 flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end"
			style="padding-bottom: max(1rem, env(safe-area-inset-bottom));"
			data-app-dialog-footer
		>
			{#if actions}
				{@render actions()}
			{:else if onPrimary}
				<Button class="sm:min-w-24" onclick={handleCancel} variant="outline">
					{secondaryLabel ?? $LL.dialogs.cancel()}
				</Button>
				<Button
					class="sm:min-w-24"
					disabled={primaryDisabled || primaryLoading}
					onclick={handlePrimary}
					variant={destructive ? 'destructive' : 'default'}
				>
					{#if primaryLoading}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{/if}
					{primaryLabel ?? $LL.dialogs.save()}
				</Button>
			{:else}
				<!-- Info-only dialog: a single close action. -->
				<DialogPrimitive.Close>
					{#snippet child({ props })}
						<Button {...props} class="sm:min-w-24" variant="outline">
							{secondaryLabel ?? $LL.dialogs.close()}
						</Button>
					{/snippet}
				</DialogPrimitive.Close>
			{/if}
		</div>
	{/if}
{/snippet}

{#if isDesktop.current}
	<Dialog.Root bind:open>
		<Dialog.Content class={cn(surfaceClass, 'sm:max-w-lg', contentClass)} showCloseButton={false}>
			{@render body()}
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<Sheet.Root bind:open>
		<Sheet.Content
			class={cn(surfaceClass, 'rounded-t-2xl', contentClass)}
			showCloseButton={false}
			side="bottom"
		>
			{@render body()}
		</Sheet.Content>
	</Sheet.Root>
{/if}
