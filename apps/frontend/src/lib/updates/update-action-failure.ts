import { RpcError, type RpcErrorEnvelope } from "../rpc/rpc-error";

export class UpdateActionFailure {
	#envelope: Pick<RpcErrorEnvelope, "code" | "retryable"> | undefined;

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
			throw error;
		}
	}
}
