import { pipelineIdForInputMode } from "@ceraui/rpc";
import type {
	CaptureDevice,
	CaptureInputMode,
	InputMode,
} from "@ceraui/rpc/schemas";
import { inputModeSchema } from "@ceraui/rpc/schemas";
import { groupDeviceCaps } from "./capabilities.ts";

/**
 * The mode families this device exposes that the board can ACTUALLY open.
 *
 * A family is published only when its `pipeline_kind` bridges to a pipeline the
 * engine currently advertises as a coarse capability source — exactly the rule
 * `buildSources` already applies to a whole device. Without it a camera could
 * offer the operator an MJPEG mode on a board whose engine never offered
 * `usb_mjpeg`, and the pick would die at `pipeline_not_in_offered_set` after
 * they had already committed to it.
 *
 * Each family carries its OWN ladder, projected through the same `groupDeviceCaps`
 * the flat list uses, so the two can never disagree about a rung.
 */
export function buildInputModes(
	device: CaptureDevice,
	offeredPipelineIds: ReadonlySet<string>,
): CaptureInputMode[] {
	const out: CaptureInputMode[] = [];
	for (const mode of device.modes ?? []) {
		const pipelineId = pipelineIdForInputMode(mode.pipeline_kind);
		if (pipelineId === undefined || !offeredPipelineIds.has(pipelineId))
			continue;
		out.push({
			inputMode: mode.pipeline_kind,
			mediaType: mode.media_type,
			pipelineId,
			modes: groupDeviceCaps(mode.caps),
		});
	}
	return out;
}

/**
 * The format this device's leg will be opened under.
 *
 * The engine's scalar kind supplies the default only when its per-device modes
 * confirm it. No mode data means no selector; global offerings are not evidence.
 */
export function resolveSelectedInputMode(
	device: CaptureDevice,
	inputModes: readonly CaptureInputMode[],
): InputMode | undefined {
	const parsed = inputModeSchema.safeParse(device.kind);
	return parsed.success &&
		inputModes.some((mode) => mode.inputMode === parsed.data)
		? parsed.data
		: undefined;
}
