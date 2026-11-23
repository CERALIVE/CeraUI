import type { UpdateProgress } from "@ceraui/rpc/schemas";

/**
 * A number is shown only while it is live: the device's own latest frame,
 * delivered on the current connection, carries it in the same phase, and it
 * is not below a number already shown in that phase. From a drop until the
 * frame is delivered again on the new connection (an identical frame counts),
 * the held phase is shown without it (the indeterminate bar), never an older
 * number.
 */
/** Set by the layout: whether the connection dropped since `field` was last delivered. */
export const CONNECTION_DROPPED = Symbol("update-connection-dropped");

const phaseOf = (progress: UpdateProgress) =>
	progress.setting_up > 0 || progress.unpacking > 0
		? 2
		: progress.downloading > 0
			? 1
			: 0;

export function createLiveProgress() {
	let shownBefore:
		| { readonly phase: number; readonly percent: number }
		| undefined;
	return (
		shown: UpdateProgress | undefined,
		frame: UpdateProgress | null | undefined,
		dropped: boolean,
	): UpdateProgress | undefined => {
		if (!shown) shownBefore = undefined;
		if (shown?.percent === undefined) return shown;
		const phase = phaseOf(shown);
		if (shownBefore && shownBefore.phase !== phase) shownBefore = undefined;
		if (
			!dropped &&
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
