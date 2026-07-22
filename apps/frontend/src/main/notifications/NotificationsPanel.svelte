<!--
  NotificationsPanel.svelte — persistent device-notification surface.

  Distinct from the transient svelte-sonner toast stream (LayoutToastHost): this
  lists the *persistent* notifications (`getPersistent()`) the device keeps
  showing until explicitly cleared, exposes a per-item dismiss, and surfaces an
  unread-count badge in the header. New persistent items arrive live through the
  same `notifications` broadcast the toast layer already consumes.

  E-ink: entrance motion is gated on `prefersEinkTheme` (no JS-driven Svelte
  transitions). The global e-ink CSS freeze (app.css) already kills CSS motion;
  this keeps the runes-side honest so a profile switch can't smear e-paper.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import Bell from '@lucide/svelte/icons/bell';
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import CircleCheck from '@lucide/svelte/icons/circle-check';
import Inbox from '@lucide/svelte/icons/inbox';
import Info from '@lucide/svelte/icons/info';
import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
import XIcon from '@lucide/svelte/icons/x';
import type { Component } from 'svelte';

import type { NotificationType } from '@ceraui/rpc/schemas';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Badge } from '$lib/components/ui/badge';
import { Button } from '$lib/components/ui/button';
import { rpc } from '$lib/rpc';
import { requestDialog } from '$lib/stores/dialog-request.svelte';
import { getDisplayProfile, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { dismiss, getPersistent } from '$lib/stores/notifications.svelte';
import { cn } from '$lib/utils';

function lookupLabel(key: string): string {
	let node: unknown = $LL;
	for (const seg of key.split('.')) {
		if (node && typeof node === 'object' && seg in (node as object)) {
			node = (node as Record<string, unknown>)[seg];
		} else {
			return key;
		}
	}
	return typeof node === 'function' ? (node as () => string)() : key;
}

let open = $state(false);

const items = $derived(getPersistent());
const count = $derived(items.length);
const frozen = $derived(prefersEinkTheme(getDisplayProfile()));

const ICONS: Record<NotificationType, Component> = {
	success: CircleCheck,
	warning: TriangleAlert,
	error: CircleAlert,
	info: Info,
};

const TONES: Record<NotificationType, string> = {
	success: 'text-primary',
	warning: 'text-primary',
	error: 'text-destructive',
	info: 'text-primary',
};

async function handleDismiss(name: string) {
	dismiss(name);
	try {
		await rpc.notifications.dismiss({ name });
	} catch {
		/* Backend dismiss is best-effort: the optimistic local removal above is the
		   source of truth for the panel; a server-side remove broadcast (if any)
		   reconciles idempotently through subscriptions.svelte. */
	}
}
</script>

<Button
	variant="ghost"
	size="icon"
	class="relative"
	aria-label={$LL.notifications.panel.trigger({ count })}
	data-testid="notifications-bell"
	onclick={() => (open = true)}
>
	<Bell class="size-5" aria-hidden="true" />
	{#if count > 0}
		<Badge
			class="pointer-events-none absolute -end-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px] leading-none tabular-nums"
			data-testid="notifications-unread-count"
		>
			{count}
		</Badge>
	{/if}
</Button>

<AppDialog bind:open title={$LL.notifications.panel.title()} icon={Bell} hideFooter>
	{#if count === 0}
		<div
			class="flex flex-col items-center gap-3 py-10 text-center"
			data-testid="notifications-empty"
		>
			<div class="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
				<Inbox class="size-6" aria-hidden="true" />
			</div>
			<p class="text-foreground text-sm font-medium">{$LL.notifications.panel.empty()}</p>
			<p class="text-muted-foreground max-w-xs text-sm leading-relaxed">
				{$LL.notifications.panel.emptyHint()}
			</p>
		</div>
	{:else}
		<ul class="flex flex-col gap-2" data-testid="notifications-list">
			{#each items as item (item.name)}
				{@const Icon = ICONS[item.type]}
				<li
					class={cn(
						'bg-card flex items-start gap-3 rounded-lg border p-3',
						!frozen && 'animate-in fade-in slide-in-from-top-1 duration-200',
					)}
					data-testid="notification-item"
					data-notification={item.name}
				>
					<Icon class={cn('mt-0.5 size-4 shrink-0', TONES[item.type])} aria-hidden="true" />
					<div class="min-w-0 flex-1">
						<p class="text-foreground text-sm leading-relaxed break-words">
							{item.text}
						</p>
						{#if item.action?.kind === 'navigate'}
							<Button
								class="mt-2 h-7 px-2 text-xs"
								size="sm"
								variant="outline"
								data-testid="notification-action"
								onclick={() => {
									const target = item.action?.target;
									if (target) requestDialog(target);
									open = false;
								}}
							>
								{lookupLabel(item.action.labelKey)}
							</Button>
						{/if}
					</div>
					{#if item.isDismissable}
						<Button
							class="size-7 shrink-0"
							size="icon"
							variant="ghost"
							aria-label={$LL.notifications.panel.dismiss()}
							data-testid="notification-dismiss"
							onclick={() => handleDismiss(item.name)}
						>
							<XIcon class="size-4" />
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</AppDialog>
