<!--
  BootButton.svelte: below 1024 px the boot picker sits behind this header
  button, which shows the chosen boot and opens the picker in a nested sheet;
  choosing a boot or Escape closes it. It appears once this view's copy loaded
  and the device answered the boot list, so an older backend shows no button.
  It is `relative` because app.css anchors its touch hit-area overlay to the
  nearest positioned box; unpositioned, that overlay covers the whole header.
  `me-1` keeps that hit area 8 px clear of the dialog's close button (DESIGN.md TT-2),
  and `my-0.5` keeps its 44 px height off the title when the header wraps.
  Its label (a short name or a start time) never breaks inside a word or a
  timestamp token such as 16日 or 오전.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import { ChevronDown } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { canListBoots } from '$lib/device-logs/boot-list.svelte';
import { formatBootTime } from '$lib/device-logs/boot-rows';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { ensureDialogNamespaces } from '$lib/i18n/namespace-activation';
import { rpc } from '$lib/rpc/client';

import BootPicker from './BootPicker.svelte';
import ParamText from './ParamText.svelte';

const uid = $props.id();
let available = $state(false);
let open = $state(false);

void canListBoots(
	() => ensureDialogNamespaces('systemLogs'),
	() => rpc.logs.boots(),
).then((offered) => {
	available = offered;
});

const boot = $derived(bootSelection.boot);
const historical = $derived(boot !== null && !boot.current);
</script>

{#if available}
	{#if !historical}
		<span hidden id="{uid}-name">{m['systemLogs.boots.open']()}</span>
	{/if}
	<Button
		aria-labelledby={historical ? `${uid}-label` : `${uid}-name ${uid}-label`}
		class="relative my-0.5 me-1 h-auto min-h-7 max-w-full min-w-0 shrink gap-1.5 whitespace-normal text-start text-pretty"
		data-testid="boot-button"
		data-touch-target="hit-area"
		onclick={() => (open = true)}
		size="sm"
		variant="outline"
	>
		<span class="break-keep" id="{uid}-label">
			{#if boot === null}
				{m['systemLogs.boots.all']()}
			{:else if boot.current}
				{m['systemLogs.boots.current']()}
			{:else}
				<ParamText
					format={(time) => m['systemLogs.boots.started']({ time })}
					value={formatBootTime(boot.firstTs, getLocale())}
				/>
			{/if}
		</span>
		<ChevronDown class="size-4 shrink-0" />
	</Button>
	<AppDialog bind:open hideFooter title={m['systemLogs.boots.heading']()} touchRegion>
		<BootPicker onchoose={() => (open = false)} />
	</AppDialog>
{/if}
