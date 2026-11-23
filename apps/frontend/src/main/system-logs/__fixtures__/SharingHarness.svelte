<!--
  SharingHarness.svelte: the Sharing group with the two dialogs SystemLogsView
  mounts beside it, so a test can open each flow from the group's rows.
-->
<script lang="ts">
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import BundleDialog from '../BundleDialog.svelte';
import ExportDialog from '../ExportDialog.svelte';
import SharingSection from '../SharingSection.svelte';

let { sharing }: { sharing: SharingFlow } = $props();
</script>

<SharingSection {sharing} />
<ExportDialog {sharing} />
<BundleDialog {sharing} />
