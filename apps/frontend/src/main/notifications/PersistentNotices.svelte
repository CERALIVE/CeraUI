<!--
  PersistentNotices.svelte — the IN-FLOW home for persistent device notices.

  A persistent notification has no expiry: `LayoutToastHost` used to hand it to
  svelte-sonner with `duration: Number.POSITIVE_INFINITY`, which put a permanent
  card on an overlay layer at `z-index: 999999999`. Board-measured on `ceralive2`
  (task 41's fleet drill), the duplicate-IP notice therefore:

    · owned the bottom-centre hit-test point at 375x812 and 768x900 — the fixed
      mobile dock is `z-40`, so a Settings tap reached the notice, not the nav;
    · covered the bottom-right corner of every AppDialog at 1024x600, i.e. the
      primary action of the surface the operator had just opened.

  Neither is recoverable by waiting, and neither is a styling accident: a toast
  is transient BY DEFINITION, so anything permanent does not belong on that
  layer. This band is the same content in the document's own flow — it can push
  content down, it can never cover it, and it has no z-index at all.

  It is NOT a replacement for `NotificationsPanel`: the bell keeps the unread
  count and the archive. This is the surface the operator meets without looking.

  E-ink: entrance motion is gated on `prefersEinkTheme`, matching the panel — the
  global e-ink CSS freeze already kills CSS motion, and this keeps the runes side
  honest so a profile switch cannot smear e-paper.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import XIcon from '@lucide/svelte/icons/x';

import { Button } from '$lib/components/ui/button';
import { requestDialog } from '$lib/stores/dialog-request.svelte';
import { getDisplayProfile, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { getPersistent } from '$lib/stores/notifications.svelte';
import { cn } from '$lib/utils';

import {
	dismissPersistentNotification,
	NOTIFICATION_BAND_CLASS,
	NOTIFICATION_BAND_ICON_CLASS,
	NOTIFICATION_ICONS,
} from './notification-presentation';

const items = $derived(getPersistent());
const frozen = $derived(prefersEinkTheme(getDisplayProfile()));
</script>

{#if items.length > 0}
	<!-- ONE live region for the band, on the container. Per-<li> `role="status"`
	     would override each item's implicit `listitem` role and leave the <ul>
	     with no list children — and would announce each notice separately. -->
	<div class="container max-w-7xl pt-3" role="status">
		<ul class="flex flex-col gap-2" data-testid="persistent-notices">
			{#each items as item (item.name)}
				{@const Icon = NOTIFICATION_ICONS[item.type]}
				<li
					class={cn(
						'flex items-start gap-3 rounded-xl border p-3',
						NOTIFICATION_BAND_CLASS[item.type],
						!frozen && 'animate-in fade-in slide-in-from-top-1 duration-200',
					)}
					data-testid="persistent-notice"
					data-notification={item.name}
					data-notification-type={item.type}
				>
					<Icon
						class={cn('mt-0.5 size-5 shrink-0', NOTIFICATION_BAND_ICON_CLASS[item.type])}
						aria-hidden="true"
					/>
					<div class="min-w-0 flex-1">
						<p class="text-foreground text-sm leading-relaxed break-words">
							{item.text}
						</p>
						{#if item.action?.kind === 'navigate'}
							<Button
								class="mt-2 h-7 px-2 text-xs"
								size="sm"
								variant="outline"
								data-testid="persistent-notice-action"
								onclick={() => {
									const target = item.action?.target;
									if (target) requestDialog(target);
								}}
							>
								{resolveMessageKey(item.action.labelKey)}
							</Button>
						{/if}
					</div>
					{#if item.isDismissable}
						<Button
							class="size-7 shrink-0"
							size="icon"
							variant="ghost"
							aria-label={m["notifications.panel.dismiss"]()}
							data-testid="persistent-notice-dismiss"
							onclick={() => void dismissPersistentNotification(item.name)}
						>
							<XIcon class="size-4" />
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}
