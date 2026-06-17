<!--
  field-sync-demo.svelte — dev-only showcase for the per-field sync-state machine
  (Task 5). Drives a demo field through idle → pending → applying → applied | failed
  and renders the shared FieldSyncIndicator against it, so the InlineSpinner
  "applying" affordance can be eyeballed (and captured by the @visual spec) before
  any real config field consumes the engine in Wave 2.

  Dev-only diagnostic: copy strings are inline literals (not i18n) like the
  console-test panel — this never ships to a user-facing surface.
-->
<script lang="ts">
import { Activity } from '@lucide/svelte';

import FieldSyncIndicator from '$lib/components/custom/FieldSyncIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import {
	beginFieldSync,
	getFieldState,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from '$lib/rpc/field-sync-state.svelte';

const DEMO_FIELD = 'demo_max_br';

const state = $derived(getFieldState(DEMO_FIELD));

// Enter `applying` and HOLD there (no auto-resolve) so the spinner is stable for
// inspection / screenshotting; the 10s TTL valve still releases it eventually.
function apply() {
	beginFieldSync(DEMO_FIELD, 8000);
	markFieldApplying(DEMO_FIELD);
}

function resolveApplied() {
	// Release to the server-applied (clamped) value, never the intended one.
	markFieldApplied(DEMO_FIELD, 6000);
}

function resolveFailed() {
	markFieldFailed(DEMO_FIELD, 4000);
}
</script>

<Card.Root class="overflow-hidden" data-testid="field-sync-demo">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<Activity class="text-primary h-5 w-5" />
			Field Sync State
		</Card.Title>
		<Card.Description>
			Per-field lifecycle: idle → pending → applying → applied | failed
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4 pb-6">
		<div class="bg-muted/50 flex items-center justify-between rounded-lg border p-3">
			<span class="font-mono text-xs font-medium">{DEMO_FIELD}</span>
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground font-mono text-xs" data-testid="field-sync-demo-state">
					{state}
				</span>
				<FieldSyncIndicator
					field={DEMO_FIELD}
					applyingLabel="Applying…"
					appliedLabel="Applied"
					failedLabel="Failed"
					data-testid="field-sync-demo-indicator"
				/>
			</div>
		</div>

		<div class="flex flex-wrap gap-2">
			<Button
				class="border-status-info/30 text-status-info hover:bg-status-info/10"
				data-testid="field-sync-demo-apply"
				onclick={apply}
				size="sm"
				variant="outline"
			>
				Apply
			</Button>
			<Button
				class="border-status-success/30 text-status-success hover:bg-status-success/10"
				onclick={resolveApplied}
				size="sm"
				variant="outline"
			>
				Resolve applied
			</Button>
			<Button
				class="border-status-warning/30 text-status-warning hover:bg-status-warning/10"
				onclick={resolveFailed}
				size="sm"
				variant="outline"
			>
				Fail
			</Button>
		</div>
	</Card.Content>
</Card.Root>
