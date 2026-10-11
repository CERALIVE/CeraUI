import { RpcError, type RpcErrorEnvelope } from "../rpc/rpc-error";

/**
 * What became of one update action, as far as the browser can tell.
 *
 * Only the DEVICE can refuse: a `{ success: false }` answer or a typed RPC
 * error envelope. A call that threw anything else (the client's timeout, a
 * socket dropped mid-request) never got an answer, so its outcome is
 * `unconfirmed`, not refused (C-M1). `not-sent` is a call `osCommand` declined
 * to dispatch because the same action was still in flight.
 */
export type UpdateActionVerdict =
	| { readonly kind: "started" }
	| {
			readonly kind: "refused";
			readonly reason: string | undefined;
			readonly retryable?: boolean;
	  }
	| { readonly kind: "unconfirmed" }
	| { readonly kind: "not-sent" };

export class UpdateActionFailure {
	#envelope: Pick<RpcErrorEnvelope, "code" | "retryable"> | undefined;
	#unanswered = false;

	get envelope(): Pick<RpcErrorEnvelope, "code" | "retryable"> | undefined {
		return this.#envelope;
	}

	async run<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof RpcError)
				this.#envelope = {
					code: error.code,
					...(error.retryable !== undefined
						? { retryable: error.retryable }
						: {}),
				};
			else this.#unanswered = true;
			throw error;
		}
	}

	verdict(
		result: { success: boolean; error?: string } | undefined,
	): UpdateActionVerdict {
		if (result?.success) return { kind: "started" };
		if (result !== undefined) return { kind: "refused", reason: result.error };
		if (this.#envelope !== undefined)
			return {
				kind: "refused",
				reason: this.#envelope.code,
				...(this.#envelope.retryable !== undefined
					? { retryable: this.#envelope.retryable }
					: {}),
			};
		return this.#unanswered ? { kind: "unconfirmed" } : { kind: "not-sent" };
	}
}
