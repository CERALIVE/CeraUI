<!--
  ViewLogsAction.svelte: "View logs" beside a message that sends the operator
  to System Logs. Renders only for a key in LOG_POINTER_KEYS and opens the view
  on Raw logs around `at` (the message's time when known, else the click); a
  standing `notice` opens at its own event or live arrival instead.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import ScrollText from '@lucide/svelte/icons/scroll-text';

import { Button } from '$lib/components/ui/button';
import { LOG_POINTER_KEYS } from '$lib/device-logs/log-pointer-keys';
import { type NoticeMoment, viewLogs, viewNoticeLogs } from '$lib/device-logs/view-logs';
import { cn } from '$lib/utils';

interface Props {
	messageKey: string | undefined;
	at?: number;
	notice?: NoticeMoment;
	class?: string;
	/** Called after the request, so an enclosing surface can close itself. */
	onViewLogs?: () => void;
}

let { messageKey, at, notice, class: className, onViewLogs }: Props = $props();

function open(): void {
	if (notice) viewNoticeLogs(notice);
	else viewLogs(at);
	onViewLogs?.();
}
</script>

{#if LOG_POINTER_KEYS.has(messageKey)}
	<!-- align-top: the leading icon would otherwise set the inline baseline and
	     lift this above a text-only neighbouring action. -->
	<Button
		class={cn('align-top', className)}
		data-testid="view-logs-action"
		onclick={open}
		size="sm"
		variant="outline"
	>
		<ScrollText aria-hidden="true" />
		{m['notifications.viewLogs']()}
	</Button>
{/if}
