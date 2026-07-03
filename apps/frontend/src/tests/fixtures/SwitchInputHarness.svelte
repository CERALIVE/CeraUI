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
import { canLiveSwitchInput } from '$lib/streaming/liveAudioSwitch';

let {
	devices = [],
	activeInput = undefined,
	audioLiveSwitchEnabled = false,
}: {
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	audioLiveSwitchEnabled?: boolean;
} = $props();

let switchingInput = $state<string | undefined>(undefined);

async function handleSwitchInput(inputId: string) {
	// Mirrors LiveView's defensive guard: the disabled-with-reason audio Switch
	// button normally makes this unreachable, but if the dispatch somehow fires
	// with the capability off, surface a calm toast instead of a silent warning.
	if (!canLiveSwitchInput(inputId, audioLiveSwitchEnabled)) {
		toast.warning($LL.live.inputPicker.audioSwitchUnavailable());
		return;
	}
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
	{audioLiveSwitchEnabled}
	{devices}
	isStreaming={true}
	onSwitch={handleSwitchInput}
	{switchingInput}
/>

<!--
  Force-invoke seam for the defensive-guard test: the audio Switch button is
  disabled-with-reason when the capability is off, so a normal click can never
  reach `handleSwitchInput`. This hidden button lets the test simulate "the
  dispatch somehow fired anyway" and assert the calm toast fallback.
-->
<button data-testid="force-audio-switch" type="button" onclick={() => handleSwitchInput('audio:usbaudio')}
	>force audio switch</button
>
