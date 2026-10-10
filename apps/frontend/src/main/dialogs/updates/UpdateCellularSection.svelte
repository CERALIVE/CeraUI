<!--
  UpdateCellularSection.svelte — what the device may download over a metered
  cellular uplink (Todo 41).

  Two pessimistic toggles (packages; system image CHECKS), and — only while the
  orchestrator is actually holding one — the pending system-image download with
  its real size and a one-time "Download over cellular now". The approval is for
  exactly the candidate the device named (`pendingCellular.id`); the dialog's
  surface grants it and starts the download in one step, so the button never
  means "some time later".

  The system image toggle allows CHECKS only. A system image is never downloaded
  over cellular without this explicit per-candidate approval, whatever the
  toggle says — the hint states that plainly rather than letting the switch read
  as a download permission.
-->
<script lang="ts">
import { formatBytes } from '@ceraui/i18n/formatters';
import { getLocale, m } from '@ceraui/i18n/svelte';
import type { UpdateDetails, UpdateSettings } from '@ceraui/rpc/schemas';
import { Download, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Switch } from '$lib/components/ui/switch';

interface Props {
	settings: UpdateSettings;
	system: boolean;
	saving: boolean;
	pending: UpdateDetails['pendingCellular'] | undefined;
	approving: boolean;
	onSave: (patch: Partial<UpdateSettings>) => Promise<boolean>;
	onApprove: (id: string) => void;
}

let { settings, system, saving, pending, approving, onSave, onApprove }: Props = $props();

const locale = $derived(getLocale());
</script>

<section aria-labelledby="updates-cellular-heading" class="space-y-2.5" data-testid="updates-cellular">
	<h3 class="text-sm font-semibold" id="updates-cellular-heading">{m['settings.updates.cellular.title']()}</h3>

	{#if system && pending}
		<div
			class="border-status-warning/40 bg-status-warning/10 space-y-3 rounded-lg border px-4 py-3"
			data-pending-id={pending.id}
			data-testid="update-cellular-pending"
			role="status"
		>
			<div class="flex items-start gap-2.5">
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-1">
					<p class="text-sm font-medium">{m['settings.updates.cellular.pendingTitle']()}</p>
					<p class="text-muted-foreground text-sm" data-testid="update-cellular-pending-body">
						{m['settings.updates.cellular.pendingBody']({
							version: pending.id,
							size: formatBytes(locale)(pending.sizeBytes),
						})}
					</p>
				</div>
			</div>
			<Button
				aria-busy={approving}
				class="w-full gap-2"
				data-testid="update-cellular-approve"
				disabled={approving}
				onclick={() => onApprove(pending.id)}
			>
				<Download class="size-4" />
				{approving ? m['network.os.applying']() : m['settings.updates.cellular.approve']()}
			</Button>
		</div>
	{/if}

	<div class="divide-border divide-y overflow-hidden rounded-lg border">
		<div class="flex items-center justify-between gap-4 px-4 py-3">
			<p class="min-w-0 text-sm font-medium">{m['settings.updates.cellular.packages']()}</p>
			<Switch
				aria-label={m['settings.updates.cellular.packages']()}
				bind:checked={
					() => settings.allowPackagesOverCellular,
					(next) => void onSave({ allowPackagesOverCellular: next })
				}
				data-testid="update-cellular-packages"
				disabled={saving}
			/>
		</div>
		{#if system}
			<div class="flex items-center justify-between gap-4 px-4 py-3">
				<div class="min-w-0">
					<p class="text-sm font-medium">{m['settings.updates.cellular.system']()}</p>
					<p class="text-muted-foreground mt-0.5 text-xs">{m['settings.updates.cellular.systemHint']()}</p>
				</div>
				<Switch
					aria-label={m['settings.updates.cellular.system']()}
					bind:checked={
						() => settings.allowSystemOverCellular,
						(next) => void onSave({ allowSystemOverCellular: next })
					}
					data-testid="update-cellular-system"
					disabled={saving}
				/>
			</div>
		{/if}
	</div>
</section>
