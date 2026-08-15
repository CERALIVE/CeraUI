<!--
  DeviceHealthDialog.svelte — the Device Health instrument panel.

  One focused Settings dialog that answers "is this box healthy, and can I trust
  the numbers?" without a console. It is a READING INSTRUMENT: zero mutating
  actions, so the header's close button is the entire interaction surface — and
  `app.css` already lifts that to the 44px touch target under
  `data-layout-mode='touch'`, which is why the panel carries no touch-target debt.

  A thin AppDialog shell by design. `SettingsView` mounts all dialogs
  permanently (closed) and AppDialog renders its children only while open, so
  keeping the instrument in `device-health/DeviceHealthPanel.svelte` is what
  guarantees the telemetry graph is read exactly while the operator is looking at
  it — never on an ordinary Settings render.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Gauge } from '@lucide/svelte';
import { MediaQuery } from 'svelte/reactivity';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { HEALTH_COMPACT_QUERY } from '$lib/layout';

import DeviceHealthPanel from './device-health/DeviceHealthPanel.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();


// The footer holds nothing but a second Close button, and on the 1024x600 kiosk
// panel its 77px is most of the 99px that made the instrument scroll — which it
// must never do. Dropped exactly where height is scarce; the header's close
// button, Esc, and the overlay all still close the dialog.
const isCompact = new MediaQuery(HEALTH_COMPACT_QUERY);
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-2xl"
	description={m["settings.deviceHealth.description"]()}
	hideFooter={isCompact.current}
	icon={Gauge}
	title={m["settings.deviceHealth.title"]()}
>
	<DeviceHealthPanel />
</AppDialog>
