/*
    CeraUI - cellular boot-ORDER lock.

    Two halves, and NEITHER is sufficient alone.

    `main.ts` is a top-level-`await` entry module that binds a WS server, spawns
    watchers and installs signal handlers, so no test can import and run it — the
    existing `main.test.ts` models the boot ladder with a local `simulateBoot`
    for exactly that reason. A behavioural model can prove the CONTRACT (a
    non-critical failure is swallowed, order is preserved) but it cannot see a
    reorder inside the real file, so on its own it would stay green while the
    device booted its modem loop ahead of its cellular stack.

    So this suite adds a STATIC assertion over `main.ts`'s own source — the same
    device `udev-rules-sigusr2-scope.test.ts` uses to pin a shipped rule file it
    cannot execute. Moving either `guardNonCritical` call below
    `initModemUpdateLoop` in `main.ts` reddens it; deleting either reddens it.
*/

import { describe, expect, test } from "bun:test";

import { guardNonCritical, runCritical } from "../helpers/boot-guard.ts";

const MAIN_SOURCE = await Bun.file(
	new URL("../main.ts", import.meta.url),
).text();

/** Offset of a boot statement in `main.ts`, or -1 when it is absent. */
function offsetOf(needle: string): number {
	return MAIN_SOURCE.indexOf(needle);
}

const CELLULAR_STACK_CALL =
	'guardNonCritical("cellular-stack", initCellularStack)';
const CELLULAR_SHADOW_CALL =
	'guardNonCritical("cellular-shadow", startModemShadowIfEnabled)';
const MODEM_LOOP_CALL = "initModemUpdateLoop({ monitor: networkMonitor })";

describe("cellular boot order — the shipped main.ts", () => {
	test("both cellular guards are wired at all", () => {
		expect(offsetOf(CELLULAR_STACK_CALL)).toBeGreaterThan(-1);
		expect(offsetOf(CELLULAR_SHADOW_CALL)).toBeGreaterThan(-1);
		expect(offsetOf(MODEM_LOOP_CALL)).toBeGreaterThan(-1);
	});

	/**
	 * THE assertion this suite exists for.
	 *
	 * `initModemUpdateLoop` runs its first discovery + `modems` broadcast
	 * immediately, and every modem RPC gates on the readiness snapshot
	 * `initCellularStack` commits. A loop that wins that race publishes a
	 * snapshot from whichever backend happened to be default and refuses every
	 * modem procedure with `CELLULAR_STACK_INITIALIZING` until the stack lands.
	 */
	test("the cellular stack is awaited BEFORE the modem update loop", () => {
		expect(offsetOf(CELLULAR_STACK_CALL)).toBeLessThan(
			offsetOf(MODEM_LOOP_CALL),
		);
	});

	test("shadow mode starts BEFORE the modem update loop", () => {
		expect(offsetOf(CELLULAR_SHADOW_CALL)).toBeLessThan(
			offsetOf(MODEM_LOOP_CALL),
		);
	});

	/**
	 * Shadow snapshots the mmcli side through `getModems()`, and the composition
	 * root is what decides whether that side is even the live one — so a shadow
	 * started first would take its FIRST heartbeat window against a backend
	 * selection that had not been made yet.
	 */
	test("the stack is committed before shadow observes it", () => {
		expect(offsetOf(CELLULAR_STACK_CALL)).toBeLessThan(
			offsetOf(CELLULAR_SHADOW_CALL),
		);
	});

	/**
	 * The WS control server is the operator's only lifeline (S6). Both cellular
	 * inits are non-critical and must stay strictly after it — a cellular init
	 * that hung ahead of the bind would brick boot in the field.
	 */
	test("both guards run after the critical ws-control-server bind", () => {
		const bind = offsetOf('runCritical("ws-control-server", initServer)');
		expect(bind).toBeGreaterThan(-1);
		expect(bind).toBeLessThan(offsetOf(CELLULAR_STACK_CALL));
		expect(bind).toBeLessThan(offsetOf(CELLULAR_SHADOW_CALL));
	});

	/** Non-critical means non-critical: neither may be `runCritical`. */
	test("neither cellular init is classified critical", () => {
		expect(MAIN_SOURCE).not.toContain('runCritical("cellular-stack"');
		expect(MAIN_SOURCE).not.toContain('runCritical("cellular-shadow"');
	});
});

interface BootStep {
	readonly name: string;
	readonly run: () => Promise<void> | void;
}

/**
 * The behavioural half — `main.test.ts`'s `simulateBoot` shape, narrowed to the
 * cellular slice. It proves the CONSEQUENCES of the order the static half pins:
 * that a throwing stack cannot stop the loop from running, and that the loop
 * still observes a committed stack.
 */
async function simulateCellularBoot(steps: readonly BootStep[]): Promise<void> {
	const silent = { error: () => undefined, warn: () => undefined };
	await runCritical("ws-control-server", () => undefined, { logger: silent });
	for (const step of steps) {
		await guardNonCritical(step.name, step.run, { logger: silent });
	}
}

describe("cellular boot order — behavioural consequences", () => {
	test("the loop observes a stack that has already committed", async () => {
		const ran: string[] = [];
		let committed = false;
		let backendSeenByLoop: boolean | undefined;

		await simulateCellularBoot([
			{
				name: "cellular-stack",
				run: async () => {
					await Promise.resolve();
					committed = true;
					ran.push("cellular-stack");
				},
			},
			{
				name: "cellular-shadow",
				run: () => {
					ran.push("cellular-shadow");
				},
			},
			{
				name: "modem-loop",
				run: () => {
					backendSeenByLoop = committed;
					ran.push("modem-loop");
				},
			},
		]);

		expect(ran).toEqual(["cellular-stack", "cellular-shadow", "modem-loop"]);
		expect(backendSeenByLoop).toBe(true);
	});

	/**
	 * The fallback lives INSIDE `initCellularStack`, so a throw escaping to the
	 * guard means the whole cellular subsystem is unavailable. The device must
	 * still reach its modem loop — an operator with a degraded cellular stack
	 * keeps their modem list, they do not lose the boot.
	 */
	test("a throwing cellular stack never stops the modem loop", async () => {
		const ran: string[] = [];

		await simulateCellularBoot([
			{
				name: "cellular-stack",
				run: () => {
					throw new Error("dbus unreachable and mmcli fallback failed");
				},
			},
			{
				name: "cellular-shadow",
				run: () => {
					throw new Error("shadow could not start");
				},
			},
			{
				name: "modem-loop",
				run: () => {
					ran.push("modem-loop");
				},
			},
		]);

		expect(ran).toEqual(["modem-loop"]);
	});
});
