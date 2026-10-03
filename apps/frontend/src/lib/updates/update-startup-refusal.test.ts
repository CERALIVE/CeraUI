import { expect, it } from "vitest";
import { RPC_UPDATE_INITIALIZING_CODE, RpcError } from "../rpc/rpc-error";
import { UpdateActionFailure } from "./update-action-failure";
import { actionRefusalKey } from "./update-view";

for (const retryable of [true, false, undefined]) {
	it(`preserves explicit retryability (${retryable}) in the existing RPC envelope`, () => {
		// Given the additive wire envelope, including its absence-compatible arm.
		const error = new RpcError({
			message: "initializing",
			code: RPC_UPDATE_INITIALIZING_CODE,
			...(retryable !== undefined ? { retryable } : {}),
		});
		// When the client constructs its ordinary RPC error.
		const result = error.retryable;
		// Then retryability is not coerced, stripped or defaulted.
		expect(result).toBe(retryable);
		expect(error.code).toBe("UPDATE_ORCHESTRATOR_INITIALIZING");
	});
}

it("retains the startup code through the action wrapper for the refusal view", async () => {
	// Given the backend's retryable startup error and the same wrapper the surface uses.
	const error = new RpcError({
		message: "initializing",
		code: RPC_UPDATE_INITIALIZING_CODE,
		retryable: true,
	});
	const failure = new UpdateActionFailure();
	// When osCommand observes the original rejected request.
	await expect(failure.run(() => Promise.reject(error))).rejects.toBe(error);
	// Then the view chooses initializing copy rather than generic refusal, without raw prose.
	expect(failure.envelope).toEqual({
		code: RPC_UPDATE_INITIALIZING_CODE,
		retryable: true,
	});
	expect(actionRefusalKey(failure.envelope?.code)).toBe(
		"settings.updates.refusal.initializing",
	);
});

it("keeps transport and unknown-code failures on the generic refusal path", async () => {
	// Given an untyped transport failure.
	const failure = new UpdateActionFailure();
	const error = new Error("socket unavailable");
	// When the action rejects.
	await expect(failure.run(() => Promise.reject(error))).rejects.toBe(error);
	// Then no startup claim is invented and unknown codes remain safely generic.
	expect(failure.envelope).toBeUndefined();
	expect(actionRefusalKey(undefined)).toBe("settings.updates.refusal.generic");
	expect(actionRefusalKey("new-code")).toBe("settings.updates.refusal.generic");
});
