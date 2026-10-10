import { ORPCError } from "@orpc/server";

export const UPDATE_STARTUP_PENDING = "UPDATE_ORCHESTRATOR_INITIALIZING";

export class UpdateStartupReadiness {
	private ready = false;
	constructor(private readonly packageDurable: () => boolean = () => true) {}

	setReady(ready: boolean): void {
		this.ready = ready;
	}

	assertReady(durable = true): void {
		if (!this.ready || !durable || !this.packageDurable())
			throw new ORPCError(UPDATE_STARTUP_PENDING, {
				message: "Update recovery is still initializing; retry shortly",
				data: { retryable: true },
			});
	}
}
