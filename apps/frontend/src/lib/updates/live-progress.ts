import type { UpdateProgress } from "@ceraui/rpc/schemas";

/**
 * A number is shown only while it is live: the device's own latest frame,
 * received on this connection, carries it in the same phase, and it is not
 * below a number already shown in that phase. While the connection is down,
 * and after it returns until the device sends a frame again, the held phase
 * is shown without it (the indeterminate bar), never an older number.
 */
/** Set by the layout: whether the connection to the device is down now. */
export const CONNECTION_DROPPED = Symbol("update-connection-dropped");

const phaseOf = (progress: UpdateProgress) =>
	progress.setting_up > 0 || progress.unpacking > 0
		? 2
		: progress.downloading > 0
			? 1
			: 0;

export function createLiveProgress() {
	let beforeDrop: unknown;
	let shownBefore:
		| { readonly phase: number; readonly percent: number }
		| undefined;
	return (
		shown: UpdateProgress | undefined,
		frame: UpdateProgress | null | undefined,
		dropped: boolean,
	): UpdateProgress | undefined => {
		if (dropped) beforeDrop = frame;
		if (!shown) shownBefore = undefined;
		if (shown?.percent === undefined) return shown;
		const phase = phaseOf(shown);
		if (shownBefore && shownBefore.phase !== phase) shownBefore = undefined;
		if (
			!dropped &&
			frame !== beforeDrop &&
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
