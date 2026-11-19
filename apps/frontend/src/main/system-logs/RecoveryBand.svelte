<!--
  RecoveryBand.svelte: the System Logs failure band: names what went wrong and
  offers Retry, in the app's amber recovery style. Announced once as an alert.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { RefreshCw, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';

interface Props {
	/** Retry is unavailable while the attempt it would repeat is still running. */
	busy?: boolean;
	message: string;
	onretry: () => unknown;
	testid: string;
}

let { busy = false, message, onretry, testid }: Props = $props();
</script>

<div
	class="border-status-warning/30 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
	data-testid={testid}
	role="alert"
>
	<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" />
	<div class="flex min-w-0 flex-1 flex-col items-start gap-2">
		<p class="text-sm">{message}</p>
		<Button
			aria-busy={busy}
			class="gap-1.5"
			data-testid="{testid}-retry"
			disabled={busy}
			onclick={onretry}
			size="sm"
			variant="outline"
		>
			<RefreshCw class="size-4" />
			{m['systemLogs.action.retry']()}
		</Button>
	</div>
</div>
