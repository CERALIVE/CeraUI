import type { UpdateProgress } from "@ceraui/rpc/schemas";

/**
 * A number the device sent before the connection dropped is not live: while
 * the connection is down, and after it returns until the device sends a new
 * frame, the held phase is shown without it (the indeterminate bar).
 */
/** Set by the layout: whether the connection to the device is down now. */
export const CONNECTION_DROPPED = Symbol("update-connection-dropped");

export function createLiveProgress() {
	let beforeDrop: unknown;
	return (
		shown: UpdateProgress | undefined,
		frame: unknown,
		dropped: boolean,
	): UpdateProgress | undefined => {
		if (dropped) beforeDrop = frame;
		if (shown?.percent === undefined || !(dropped || frame === beforeDrop))
			return shown;
		const { percent: _held, ...phase } = shown;
		return phase;
	};
}
