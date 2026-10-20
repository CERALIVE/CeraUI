import {
	NotSentError,
	RPC_UPDATE_INITIALIZING_CODE,
	RpcError,
	type RpcErrorEnvelope,
} from "../rpc/rpc-error";

/**
 * What a finished request proves about whether its action STARTED. Pure.
 *
 * "Not started" (`refused`) needs POSITIVE pre-dispatch evidence: the device
 * answered `{ success: false }`, raised an envelope it only raises before any
 * effect, or the client never put the request on the wire. Everything else is
 * `uncertain`: a lost reply (timeout, reset socket) or an error the device
 * raised while HANDLING the request. `INTERNAL_ERROR` is any handler fault and
 * `VALIDATION_ERROR` also covers the reply schema, which runs after the
 * handler, so neither says the action did not start (round-2 review C, M1).
 *
 * `preEffect` separates the two kinds of refusal. The envelope and a request
 * never sent are pre-effect by construction. A `{ success: false }` REPLY is
 * not: the OS-install producer answers from the END phase of a stage it may
 * already have run, so start evidence observed before that reply overrides it
 * (round-3 review C, C3-1; `update-action-outcome.ts`).
 */
export interface ActionReply {
	readonly success: boolean;
	readonly error?: string;
}

/** One request of an action; a cellular approval is two, in order. */
export type ActionStep = () => Promise<ActionReply>;

export type UncertainCause = "lost" | "error";

export type ActionVerdict =
	| { readonly kind: "accepted" }
	| {
			readonly kind: "refused";
			readonly reason: string | undefined;
			readonly retryable?: boolean;
			readonly preEffect: boolean;
	  }
	| { readonly kind: "uncertain"; readonly cause: UncertainCause };

/** The device raises these before any effect (`startupReadiness.assertReady`). */
const PRE_EFFECT_CODES: ReadonlySet<string> = new Set([
	RPC_UPDATE_INITIALIZING_CODE,
]);

export const NOT_CONNECTED_REASON = "not_connected";

export function verdictOfError(error: unknown): ActionVerdict {
	if (error instanceof NotSentError)
		return { kind: "refused", reason: NOT_CONNECTED_REASON, preEffect: true };
	if (!(error instanceof RpcError)) return { kind: "uncertain", cause: "lost" };
	if (!PRE_EFFECT_CODES.has(error.code))
		return { kind: "uncertain", cause: "error" };
	return {
		kind: "refused",
		reason: error.code,
		preEffect: true,
		...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
	};
}

/** Records the error that ended a chain of requests, untouched, for its verdict. */
export class UpdateActionFailure {
	#failed = false;
	#error: unknown;

	get envelope(): Pick<RpcErrorEnvelope, "code" | "retryable"> | undefined {
		if (!(this.#error instanceof RpcError)) return undefined;
		return {
			code: this.#error.code,
			...(this.#error.retryable !== undefined
				? { retryable: this.#error.retryable }
				: {}),
		};
	}

	async run<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			this.#failed = true;
			this.#error = error;
			throw error;
		}
	}

	/** The chain's verdict from its last reply, unless an error ended it first. */
	verdict(reply: ActionReply): ActionVerdict {
		if (this.#failed) return verdictOfError(this.#error);
		return reply.success
			? { kind: "accepted" }
			: { kind: "refused", reason: reply.error, preEffect: false };
	}
}

/**
 * Runs the steps in order and stops at the first one that is declined or
 * fails. The LAST step is the one that starts the action, so its answer is the
 * verdict; the steps before it are preconditions. Never throws.
 */
export async function runSteps(
	steps: readonly ActionStep[],
): Promise<ActionVerdict> {
	const failure = new UpdateActionFailure();
	let reply: ActionReply = { success: true };
	for (const step of steps) {
		try {
			reply = await failure.run(step);
		} catch {
			break;
		}
		if (!reply.success) break;
	}
	return failure.verdict(reply);
}
