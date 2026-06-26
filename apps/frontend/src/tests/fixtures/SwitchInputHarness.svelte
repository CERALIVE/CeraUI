<!--
  SwitchInputHarness.svelte — test harness for LiveView's live input-switch flow.

  LiveView is an 895-line surface with a dozen heavy child dialogs, so it cannot be
  mounted in isolation. This harness wires the REAL `InputPicker` to the REAL
  `osCommand` machine using the SAME non-audio `handleSwitchInput` body LiveView
  uses (key 'switch-input', classify-ok-always so the picker keeps its nuanced
  switched/source-lost/failed toasts, manual confirm/fail). It exists ONLY to let
  the switchInput async-state contract (in-flight + result + re-entry) be unit
  tested; production code lives in LiveView.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CaptureDevice } from '@ceraui/rpc/schemas';
import { SWITCH_INPUT_ERRORS } from '@ceraui/rpc/schemas';
import { toast } from 'svelte-sonner';

import InputPicker from '$lib/components/custom/InputPicker.svelte';
import {
	confirmOperation,
	failOperation,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc';

let {
	devices = [],
	activeInput = undefined,
}: { devices?: CaptureDevice[]; activeInput?: string | undefined } = $props();

let switchingInput = $state<string | undefined>(undefined);

async function handleSwitchInput(inputId: string) {
	switchingInput = inputId;
	try {
		const res = await osCommand({
			key: 'switch-input',
			target: inputId,
			rpc: () => rpc.streaming.switchInput({ input_id: inputId }),
			classify: () => ({ ok: true }),
			failMessage: () => $LL.live.inputPicker.switchFailed(),
		});
		if (!res) return;
		if (res.success) {
			confirmOperation('switch-input');
			toast.success($LL.live.inputPicker.switched({ ms: res.gap_ms ?? 0 }));
		} else {
			failOperation('switch-input', res.error ?? 'failed');
			toast.error(
				res.error === SWITCH_INPUT_ERRORS.SOURCE_LOST
					? $LL.live.inputPicker.sourceLost()
					: $LL.live.inputPicker.switchFailed(),
			);
		}
	} finally {
		switchingInput = undefined;
	}
}
</script>

<InputPicker
	{activeInput}
	{devices}
	isStreaming={true}
	onSwitch={handleSwitchInput}
	{switchingInput}
/>
