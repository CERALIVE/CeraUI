export class BackendSingletonError extends Error {
	constructor(
		readonly reason: "contended" | "unproven" | "directory-unavailable",
		options?: ErrorOptions,
	) {
		super(`Backend singleton lock: ${reason}`, options);
		this.name = "BackendSingletonError";
	}
}
