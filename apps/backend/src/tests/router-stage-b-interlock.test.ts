/**
 * Todo 22 STAGE B — both new writes go through todo 25's interlock, not beside it.
 *
 * The two halves are deliberately different, and the difference is the whole
 * design: a radio-mode selection cannot cost the LAN path to the device, so it
 * takes the LEASE ALONE; a subnet rewrite can, so it is JOURNALED — a durable
 * armed entry written before the device is touched, with a rollback handler
 * registered for startup replay.
 *
 * There are two kinds of proof here and both are needed. The BEHAVIOURAL half
 * asserts that a held lease refuses and that the effect provably never ran, which
 * is what makes it an enforcement test rather than a message test. The STATIC
 * half asserts that the two procedures actually route through those helpers —
 * because a handler that called the write function directly would pass every
 * behavioural test of the helper while bypassing it entirely.
 *
 * HONEST GAP: the static half exists because driving these two procedures
 * end-to-end needs a router-marker + netif + synthetic-id harness that this repo
 * does not have (`setRouterControl` has never had one either). Building it is
 * owed work, not something this pins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	beginModemMutation,
	withModemMutation,
} from "../modules/modems/mutation-lease.ts";
import {
	registerMutationRollback,
	resetMutationCaptureDeps,
	rollbackMutation,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import { restoreRouterSubnet } from "../modules/network/router-subnet-rollback.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.3.1";

const PROCEDURE_SOURCE = readFileSync(
	join(
		import.meta.dir,
		"..",
		"rpc",
		"procedures",
		"modems-router.procedure.ts",
	),
	"utf8",
);

/** The handler body of one exported procedure, comments stripped. */
function handlerOf(name: string): string {
	const start = PROCEDURE_SOURCE.indexOf(
		`export const ${name} = modemProcedure`,
	);
	expect(start).toBeGreaterThan(-1);
	const rest = PROCEDURE_SOURCE.slice(start);
	const end = rest.indexOf("\nexport ", 1);
	return (end === -1 ? rest : rest.slice(0, end))
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

afterEach(() => {
	resetLifecycleInterlock();
	resetMutationCaptureDeps();
});

describe("a held lease refuses, and the effect provably never runs", () => {
	test("a net-mode write cannot start while the device is being mutated", async () => {
		const held = beginModemMutation(KEY);
		expect(held.ok).toBe(true);

		let ran = false;
		const outcome = await withModemMutation(KEY, () => {
			ran = true;
			return Promise.resolve("written");
		});

		expect(outcome).toEqual({ ok: false, refusal: "mutation_in_progress" });
		expect(ran).toBe(false);
	});

	test("a device with no resolvable identity is refused before anything is read", async () => {
		let ran = false;
		const outcome = await withModemMutation(undefined, () => {
			ran = true;
			return Promise.resolve("written");
		});

		// Fail-closed: a target that cannot be journaled or re-found after a
		// re-enumeration is refused, not attempted.
		expect(outcome).toEqual({ ok: false, refusal: "identity_unresolved" });
		expect(ran).toBe(false);
	});

	test("a DIFFERENT device is unaffected — the lease is per physical device", async () => {
		const held = beginModemMutation(KEY);
		expect(held.ok).toBe(true);

		const outcome = await withModemMutation(
			"platform-xhci-hcd.0.auto-usb-0:1.3.2",
			() => Promise.resolve("written"),
		);

		expect(outcome.ok).toBe(true);
	});
});

describe("the subnet rewrite registers a replay rollback; the net-mode write does not", () => {
	test("`router-subnet` reaches its handler with the journaled pre-state", async () => {
		// Registered explicitly rather than leaning on the module's load-time side
		// effect: `bun test` is ONE process, so whether that side effect has fired
		// (and whether a sibling suite has since cleared the registry) is test-order
		// state. The side effect itself is pinned statically below, by the
		// procedure's own import.
		registerMutationRollback("router-subnet", {
			rollback: restoreRouterSubnet,
		});
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					{
						physicalUid: KEY,
						vendorId: "12d1",
						productId: "14dc",
						model: "E3372",
						firmwareRevision: "1.0",
						interfaces: [],
					},
				] as never),
		});

		// The pre-state is unreadable by this build, so the handler answers
		// `failed` — which is the fail-closed path, and it proves the handler was
		// REACHED rather than that the registry is empty.
		expect(await rollbackMutation("router-subnet", KEY, {})).toBe("failed");
	});

	test("a kind with no registered handler answers `unavailable`, never success", async () => {
		// `network-scan` is lease-only by design and will never have a rollback, so
		// this asserts the fail-visible branch without CLEARING the registry — a
		// clear would strip other suites' handlers in this one shared process.
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					{
						physicalUid: KEY,
						vendorId: "12d1",
						productId: "14dc",
						model: "E3372",
						firmwareRevision: "1.0",
						interfaces: [],
					},
				] as never),
		});

		expect(await rollbackMutation("network-scan", KEY, {})).toBe("unavailable");
	});
});

describe("both procedures route through the interlock, not around it", () => {
	test("the net-mode write takes the lease and is NOT journaled", () => {
		const handler = handlerOf("setRouterNetModeProcedure");

		expect(handler).toContain("withModemMutation(");
		expect(handler).not.toContain("withJournaledModemMutation(");
		// The write is reachable ONLY from inside the guarded callback.
		expect(handler.indexOf("withModemMutation(")).toBeLessThan(
			handler.indexOf("applyRouterNetMode("),
		);
	});

	test("the subnet rewrite is JOURNALED, with its own kind and pre-state", () => {
		const handler = handlerOf("setRouterSubnetProcedure");

		expect(handler).toContain("withJournaledModemMutation(");
		expect(handler).toContain('"router-subnet"');
		expect(handler).toContain("preStateFor(plan)");
		// Armed BEFORE the device is written: the execute call is inside the
		// journaled callback, and the journal is committed before `run` is invoked.
		expect(handler.indexOf("withJournaledModemMutation(")).toBeLessThan(
			handler.indexOf("executeSubnetRewrite("),
		);
	});

	test("only `blocked` leaves the journal entry armed", () => {
		const handler = handlerOf("setRouterSubnetProcedure");

		// A refusal changed nothing and a reverted rewrite was reconfirmed at the
		// old address, so neither leaves an outstanding risk for the journal to
		// describe — blocking on either would fail-close a device we just proved
		// healthy.
		expect(handler).toContain('confirmed: outcome.status !== "blocked"');
	});

	test("neither procedure builds its own mutation-safety mechanism", () => {
		for (const name of [
			"setRouterNetModeProcedure",
			"setRouterSubnetProcedure",
		]) {
			const handler = handlerOf(name);
			expect(handler).not.toContain("getIsStreaming(");
			expect(handler).not.toContain("tryAcquireLifecycle(");
			expect(handler).not.toContain("commitMutationEntry(");
		}
	});
});
