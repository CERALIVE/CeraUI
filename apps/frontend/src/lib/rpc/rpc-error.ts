/**
 * RPC error taxonomy — the frontend half (Task 2).
 *
 * The backend adapter classifies every handler failure as one of two wire
 * codes: `VALIDATION_ERROR` (an input/output schema rejection, carrying the
 * safe field paths that failed) or `INTERNAL_ERROR` (any other fault). This
 * module carries that code across the RPC-client boundary ({@link RpcError})
 * and maps it to a distinct, localizable toast ({@link describeRpcError},
 * {@link rpcErrorToNotification}).
 *
 * Pure + rune-free: it imports no Svelte runtime and no live `$LL`, so the
 * text resolution stays at the toast host — this layer only chooses the i18n
 * key + params.
 */
import type { Notification } from "@ceraui/rpc/schemas";

export const RPC_VALIDATION_ERROR_CODE = "VALIDATION_ERROR";
export const RPC_INTERNAL_ERROR_CODE = "INTERNAL_ERROR";

/** The additive-optional error envelope the adapter sends on the wire. */
export interface RpcErrorEnvelope {
	message: string;
	code: string;
	fields?: string[];
}

/**
 * An RPC failure that preserves the backend's taxonomy `code` and the safe
 * field paths. Extends `Error` so existing `catch`/`console.error` call sites
 * keep working against `.message` unchanged.
 */
export class RpcError extends Error {
	readonly code: string;
	readonly fields: string[];

	constructor(envelope: RpcErrorEnvelope) {
		super(envelope.message);
		this.name = "RpcError";
		this.code = envelope.code;
		this.fields = envelope.fields ?? [];
	}
}

export interface RpcErrorDescriptor {
	/** Dotted i18n key resolved at the toast host. */
	key: string;
	/** Interpolation params for {@link key}. */
	params: Record<string, string>;
	/** Raw message fallback when the key is absent from the tree. */
	fallback: string;
}

function isValidationError(error: unknown): error is RpcError {
	return error instanceof RpcError && error.code === RPC_VALIDATION_ERROR_CODE;
}

/**
 * Choose the i18n key + params for an RPC failure. A `VALIDATION_ERROR` names
 * the offending field(s); every other failure gets the generic request-failed
 * copy.
 */
export function describeRpcError(error: unknown): RpcErrorDescriptor {
	if (isValidationError(error)) {
		const fields = error.fields.filter((field) => field.length > 0);
		if (fields.length > 0) {
			return {
				key: "notifications.validationFailed",
				params: { fields: fields.join(", ") },
				fallback: error.message,
			};
		}
	}
	return {
		key: "notifications.requestFailed",
		params: {},
		fallback: error instanceof Error ? error.message : "Unknown error",
	};
}

/**
 * Bridge an RPC failure into a transient error {@link Notification} the toast
 * host can push. Deduped by taxonomy `code` so a burst of the same failure
 * replaces rather than stacks.
 */
export function rpcErrorToNotification(error: unknown): Notification {
	const descriptor = describeRpcError(error);
	const code = error instanceof RpcError ? error.code : RPC_INTERNAL_ERROR_CODE;
	return {
		name: `rpc-error:${code}`,
		type: "error",
		msg: descriptor.fallback,
		key: descriptor.key,
		params: descriptor.params,
		is_dismissable: true,
		is_persistent: false,
		duration: 6,
	};
}
