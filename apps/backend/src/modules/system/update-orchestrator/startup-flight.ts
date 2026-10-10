export class OrchestratorStartupFlight {
	#pending: Promise<void> | undefined;

	run(work: () => Promise<void>): Promise<void> {
		if (this.#pending) return this.#pending;
		const completion = Promise.withResolvers<void>();
		const pending = completion.promise.finally(() => {
			if (this.#pending === pending) this.#pending = undefined;
		});
		this.#pending = pending;
		void work().then(completion.resolve, completion.reject);
		return pending;
	}

	resetForTest(): void {
		this.#pending = undefined;
	}
}
