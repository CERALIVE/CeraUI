import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	ASYNC_OP_TTL_MS,
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
	osCommand,
	reconcileOperationsOnReconnect,
	sweepOperations,
} from "./async-operation.svelte";

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn() },
}));

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(0);
	initAsyncOperations();
});
afterEach(() => {
	destroyAsyncOperations();
	vi.restoreAllMocks();
});

it.each(["current", "timeout", "reconnect", "recreate"])(
	"clears only its captured attempt after %s (#496)",
	async (lifetime) => {
		const reply = Promise.withResolvers<{ success: boolean }>();
		const onResult = vi.fn();
		const first = osCommand({
			key: "clear-refusal",
			target: true,
			rpc: () => reply.promise,
			classify: () => ({ ok: true, clear: true }),
			confirmOnResolve: true,
			onResult,
		});
		const nextReply = Promise.withResolvers<{ success: boolean }>();
		let next: Promise<unknown> | undefined;
		if (lifetime !== "current") {
			if (lifetime === "timeout") sweepOperations(ASYNC_OP_TTL_MS + 1);
			if (lifetime === "reconnect")
				reconcileOperationsOnReconnect("connecting", "connected");
			if (lifetime === "recreate") {
				destroyAsyncOperations();
				initAsyncOperations();
			}
			next = osCommand({
				key: "clear-refusal",
				target: true,
				rpc: () => nextReply.promise,
				confirmOnResolve: true,
			});
		}
		reply.resolve({ success: false });
		expect(await first).toEqual({ success: false });
		expect(onResult).toHaveBeenCalledExactlyOnceWith({ success: false });
		expect(getOperationPhase("clear-refusal")).toBe(
			lifetime === "current" ? "idle" : "pending",
		);
		if (next) {
			nextReply.resolve({ success: true });
			await next;
			expect(getOperationPhase("clear-refusal")).toBe("confirmed");
		}
	},
);
