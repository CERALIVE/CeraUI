import type { UpdateProgress } from "@ceraui/rpc/schemas";

/**
 * Set by the layout: whether the device delivered a progress field on the
 * link that is up now. Outside the layout (a test mount) it counts as current.
 */
export const PROGRESS_CURRENT = Symbol("update-progress-current");
export type ProgressCurrent = (field: "updating" | "update_state") => boolean;

const phaseOf = (progress: UpdateProgress) =>
	progress.setting_up > 0 || progress.unpacking > 0
		? 2
		: progress.downloading > 0
			? 1
			: 0;

/**
 * A number is shown only while it is live: the device's latest frame,
 * delivered on the link that is up now (`current`), carries it in the same
 * phase, and it is not below a number already shown in that phase. Otherwise
 * the held phase is shown without a number (the indeterminate bar).
 */
export function createLiveProgress() {
	let shownBefore:
		| { readonly phase: number; readonly percent: number }
		| undefined;
	return (
		shown: UpdateProgress | undefined,
		frame: UpdateProgress | null | undefined,
		current: boolean,
	): UpdateProgress | undefined => {
		if (!shown) shownBefore = undefined;
		if (shown?.percent === undefined) return shown;
		const phase = phaseOf(shown);
		if (shownBefore && shownBefore.phase !== phase) shownBefore = undefined;
		if (
			current &&
			frame &&
			phaseOf(frame) === phase &&
			frame.percent === shown.percent &&
			shown.percent >= (shownBefore?.percent ?? 0)
		) {
			shownBefore = { phase, percent: shown.percent };
			return shown;
		}
		const { percent: _held, ...held } = shown;
		return held;
	};
}
