/**
 * How long an RPC call waits for its reply before it rejects. A rejection here
 * means the reply never arrived, NOT that the device refused: the procedure may
 * still be running on the device (an OS install answers only once staging is
 * done). Its own module so a surface can size its busy state from it without
 * importing the transport.
 */
export const RPC_CALL_TIMEOUT_MS = 30_000;

/** A call whose reply never arrived in time: the device may still be running it, and still answer. */
export class CallTimeoutError extends Error {}
