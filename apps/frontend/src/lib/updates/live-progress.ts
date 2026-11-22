import type { UpdateProgress } from "@ceraui/rpc/schemas";

/**
 * A number is shown only while it is live: the device's own latest frame,
 * received on this connection, carries it. While the connection is down, and
 * after it returns until the device sends that number again, the held phase is
 * shown without it (the indeterminate bar), never an older number.
 */
/** Set by the layout: whether the connection to the device is down now. */
export const CONNECTION_DROPPED = Symbol("update-connection-dropped");

export function createLiveProgress() {
	let beforeDrop: unknown;
	return (
		shown: UpdateProgress | undefined,
		frame: { readonly percent?: number } | null | undefined,
		dropped: boolean,
	): UpdateProgress | undefined => {
		if (dropped) beforeDrop = frame;
		if (
			shown?.percent === undefined ||
			(!dropped && frame !== beforeDrop && frame?.percent === shown.percent)
		)
			return shown;
		const { percent: _held, ...phase } = shown;
		return phase;
	};
}
