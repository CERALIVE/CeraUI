/**
 * The `eth_role` broadcast must reach the keyed async-operation store.
 *
 * `network.setEthernetRole` resolving does NOT mean the port took the role — the
 * device's terminal frame does — so the op stays `pending` past the RPC and the
 * confirming/failing signal arrives exclusively through this ingestion path. A
 * frame the handler drops is a control that spins until the TTL valve fires.
 *
 * The already-applied branch is the shape this arm exists for: it publishes its
 * terminal DIRECTLY, with NO pending frame, because nothing was dispatched and
 * no NetworkManager answer will ever settle. A handler that only settled a
 * pending→terminal SEQUENCE would leave every re-declaration of the current role
 * spinning.
 *
 * The key is asserted through `ethernetRoleOpKey` rather than a re-typed
 * literal: the handler builds it inline (matching its sibling arms), so this is
 * what pins the two spellings together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	ConnectionResetError: class ConnectionResetError extends Error {},
	rpc: { wifi: { getAdapterModes: vi.fn(async () => ({})) } },
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	ASYNC_OP_TTL_MS,
	beginOperation,
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	initAsyncOperations,
	osCommand,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	deriveEthernetRoleView,
	ethernetRoleOpKey,
	ethernetRoleTarget,
} from "$main/network/ethernet-role-view";

const KEY = ethernetRoleOpKey("eth0");

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function emit(outcome: unknown) {
	if (!handlers.message)
		throw new Error("missing registered subscription handler");
	handlers.message("eth_role", { eth_role: outcome });
}

describe("eth_role ingestion", () => {
	beforeEach(() => {
		resetState();
		initAsyncOperations();
		initSubscriptions();
	});

	it("the real pending echo and terminal preserve the current RPC result owner", async () => {
		const pending = deferred<{ success: true; applied: "shared-lan" }>();
		const onResult = vi.fn();
		const current = osCommand({
			key: KEY,
			target: "shared-lan",
			rpc: () => pending.promise,
			silent: true,
			onResult,
		});
		emit({ name: "eth0", role: "shared-lan", pending: true });
		emit({ name: "eth0", role: "shared-lan", success: true });
		const result = { success: true as const, applied: "shared-lan" as const };
		pending.resolve(result);
		expect(await current).toEqual(result);
		expect(onResult).toHaveBeenCalledWith(result);
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("same-role pending echoes preserve the no-change target and Shared LAN display", async () => {
		const pending = deferred<{ success: true }>();
		const current = osCommand({
			key: KEY,
			rpc: () => pending.promise,
			silent: true,
		});
		emit({ name: "eth0", role: "shared-lan", pending: true });
		emit({ name: "eth0", role: "shared-lan", pending: true });
		const target = getOperationTarget(KEY);
		const targetRole = ethernetRoleTarget(target);
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: { tp: 0, enabled: false, ethRole: "shared-lan" },
			phase: getOperationPhase(KEY),
			...(targetRole !== undefined ? { target: targetRole } : {}),
		});
		emit({ name: "eth0", role: "shared-lan", success: true });
		pending.resolve({ success: true });
		const result = await current;
		expect(target).toBeUndefined();
		expect(view.displayRole).toBe("shared-lan");
		expect(view.pending).toBe(true);
		expect(result).toEqual({ success: true });
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a pending echo then terminal refusal retains the current raw refusal reply", async () => {
		const pending = deferred<{ success: false; error: string }>();
		const current = osCommand({
			key: KEY,
			target: "shared-lan",
			rpc: () => pending.promise,
			silent: true,
		});
		emit({ name: "eth0", role: "shared-lan", pending: true });
		emit({ name: "eth0", error: "apply_failed" });
		const result = { success: false as const, error: "apply_failed" };
		pending.resolve(result);
		expect(await current).toEqual(result);
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("apply_failed");
	});

	it("a pending echo does not suppress the current RPC rejection when no terminal arrives", async () => {
		const pending = deferred<never>();
		const current = osCommand({
			key: KEY,
			rpc: () => pending.promise,
			silent: true,
		});
		emit({ name: "eth0", role: "shared-lan", pending: true });
		pending.reject(new Error("reply lost"));
		expect(await current).toBeUndefined();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("reply lost");
	});

	it("an external pending frame after a terminal still begins its new target", () => {
		beginOperation(KEY, "uplink");
		emit({ name: "eth0", role: "uplink", success: true });
		emit({ name: "eth0", role: "shared-lan", pending: true });
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getOperationTarget(KEY)).toBe("shared-lan");
	});

	it("a same-target echo keeps the original deadline while the role RPC is pending", async () => {
		const pending = deferred<{ success: true }>();
		const clock = vi.spyOn(Date, "now").mockReturnValue(0);
		const current = osCommand({
			key: KEY,
			target: "shared-lan",
			rpc: () => pending.promise,
			silent: true,
		});
		clock.mockReturnValue(5_000);
		emit({ name: "eth0", role: "shared-lan", pending: true });
		clock.mockRestore();
		pending.resolve({ success: true });
		expect(await current).toEqual({ success: true });
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getOperationTarget(KEY)).toBe("shared-lan");
		sweepOperations(ASYNC_OP_TTL_MS + 1);
		expect(getOperationPhase(KEY)).toBe("timed_out");
	});

	it("an overlapping external different-target echo replaces the local pending target", async () => {
		const pending = deferred<{ success: true }>();
		const current = osCommand({
			key: KEY,
			target: "shared-lan",
			rpc: () => pending.promise,
			silent: true,
		});
		emit({ name: "eth0", role: "uplink", pending: true });
		const target = getOperationTarget(KEY);
		pending.resolve({ success: true });
		expect(await current).toEqual({ success: true });
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(target).toBe("uplink");
	});

	it.each(["uplink", "shared-lan"])(
		"a local refusal preserves an external %s pending frame and its terminal success",
		async (role) => {
			const reply = Promise.withResolvers<{
				success: boolean;
				error: string;
			}>();
			const command = osCommand({
				key: KEY,
				target: "shared-lan",
				rpc: () => reply.promise,
				silent: true,
			});
			handlers.message?.("eth_role", {
				eth_role: { name: "eth0", error: "apply_failed" },
			});
			handlers.message?.("eth_role", {
				eth_role: { name: "eth0", role, pending: true },
			});
			reply.resolve({ success: false, error: "apply_failed" });
			await command;
			expect(getOperationPhase(KEY)).toBe("pending");
			expect(getOperationTarget(KEY)).toBe(role);
			expect(getOperationReason(KEY)).toBeUndefined();
			handlers.message?.("eth_role", {
				eth_role: { name: "eth0", role, success: true },
			});
			expect(getOperationPhase(KEY)).toBe("confirmed");
		},
	);

	it("a pending frame begins the op and records the target role", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getOperationTarget(KEY)).toBe("shared-lan");
	});

	it("a pending→terminal sequence confirms it", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", success: true },
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a DIRECT terminal with no pending frame still settles the op", () => {
		// The already-applied branch: the dispatcher (osCommand) begins the op
		// before the RPC leaves, so the terminal lands on a pending op even though
		// the device never published a pending frame of its own.
		beginOperation(KEY, "uplink");
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "uplink", success: true },
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a terminal error fails it and keeps the device's own typed reason", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", error: "apply_failed" },
		});
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("apply_failed");
	});

	it("a DIRECT terminal error settles it too", () => {
		beginOperation(KEY, "shared-lan");
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", error: "no_connection" },
		});
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("no_connection");
	});

	it("leaves a sibling port's op untouched", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		expect(getOperationPhase(ethernetRoleOpKey("eth1"))).toBe("idle");
	});

	it("ignores a frame carrying no name", () => {
		handlers.message?.("eth_role", { eth_role: { role: "uplink" } });
		expect(getOperationPhase(KEY)).toBe("idle");
	});

	it("ignores a frame with no eth_role payload at all", () => {
		handlers.message?.("eth_role", {});
		expect(getOperationPhase(KEY)).toBe("idle");
	});

	it.each([
		{ role: "uplink", pending: true },
		{ role: "shared-lan", pending: true },
		{ role: "shared-lan", success: true },
		{ error: "apply_failed" },
	])(
		"ignores another client's tagged frame %j while mine is pending (#489)",
		async (frame) => {
			const reply = Promise.withResolvers<{
				success: boolean;
				error: string;
			}>();
			const target = {
				name: "eth0",
				role: "shared-lan",
				op: "client-a-0000001",
			};
			const command = osCommand({
				key: KEY,
				target,
				rpc: () => reply.promise,
				silent: true,
			});

			emit({ name: "eth0", op: "client-b-0000001", ...frame });
			const phase = getOperationPhase(KEY);
			const heldTarget = getOperationTarget(KEY);
			reply.resolve({ success: false, error: "no_connection" });
			await command;

			expect(phase).toBe("pending");
			expect(heldTarget).toEqual(target);
			expect(getOperationPhase(KEY)).toBe("failed");
			expect(getOperationReason(KEY)).toBe("no_connection");
		},
	);

	it.each([
		{
			success: true,
			role: "shared-lan",
			phase: "confirmed",
			reason: undefined,
		},
		{ error: "apply_failed", phase: "failed", reason: "apply_failed" },
	])(
		"settles only my tagged terminal without replacing its target: %j (#489)",
		(terminal) => {
			const target = {
				name: "eth0",
				role: "shared-lan",
				op: "client-a-0000001",
			};
			const clock = vi.spyOn(Date, "now").mockReturnValue(0);
			beginOperation(KEY, target);
			clock.mockReturnValue(5_000);
			emit({ ...target, pending: true });
			clock.mockRestore();

			expect(getOperationTarget(KEY)).toEqual(target);
			emit({ name: "eth0", op: target.op, ...terminal });
			expect(getOperationPhase(KEY)).toBe(terminal.phase);
			expect(getOperationReason(KEY)).toBe(terminal.reason);
		},
	);

	it("foreign tagged frames cannot start or revive an operation (#489)", () => {
		emit({
			name: "eth0",
			role: "uplink",
			op: "client-b-0000001",
			pending: true,
		});
		expect(getOperationPhase(KEY)).toBe("idle");
		const target = { name: "eth0", role: "shared-lan", op: "client-a-0000001" };
		beginOperation(KEY, target);
		emit({ ...target, success: true });
		emit({
			name: "eth0",
			role: "uplink",
			op: "client-b-0000001",
			pending: true,
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("tagged same-target echoes keep the original timeout (#489)", () => {
		const target = { name: "eth0", role: "shared-lan", op: "client-a-0000001" };
		const clock = vi.spyOn(Date, "now").mockReturnValue(0);
		beginOperation(KEY, target);
		clock.mockReturnValue(5_000);
		emit({ ...target, pending: true });
		emit({ ...target, op: "client-b-0000001", pending: true });
		clock.mockRestore();
		sweepOperations(ASYNC_OP_TTL_MS + 1);
		expect(getOperationPhase(KEY)).toBe("timed_out");
	});

	it("an untagged same-role echo preserves a correlated target (#489)", () => {
		const target = { name: "eth0", role: "shared-lan", op: "client-a-0000001" };
		beginOperation(KEY, target);
		emit({ name: "eth0", role: "shared-lan", pending: true });
		expect(getOperationTarget(KEY)).toEqual(target);
		emit({ name: "eth0", role: "shared-lan", success: true });
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});
});
