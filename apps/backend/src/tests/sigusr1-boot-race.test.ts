/*
 * Regression guard for the SIGUSR1 boot-race kill of `ceralive.service`.
 *
 * BUG: SIGUSR1 and SIGUSR2 default to TERMINATE. `main.ts` is a top-level-await
 * boot ladder and installed `process.on("SIGUSR1", …)` at its very END — after
 * config load, the WS bind, the engine probe and the network/audio scans. Every
 * second of that ladder was a window in which an arriving SIGUSR1 killed the
 * backend outright.
 *
 * The sender fires in exactly that window:
 * `ceralive-addon-reconciler.service` is `After=ceralive.service`, so systemd
 * runs its `systemctl kill --signal=SIGUSR1 ceralive.service` as soon as the
 * unit reports STARTED — which is when the ladder begins, not when it ends.
 *
 * SECOND, INDEPENDENT HAZARD: that oneshot omitted `--kill-whom=main`, and
 * systemctl's default is `all`. srtla_send shares `ceralive.service`'s cgroup
 * while streaming and does not handle SIGUSR1, so a reconcile poke could
 * terminate the sender mid-broadcast. This is the same defect the two SIGUSR2
 * udev rules were already fixed for (see udev-rules-sigusr2-scope.test.ts).
 *
 * FIX, both halves:
 *   1. `helpers/boot-signals.ts` reserves both signals with an inert recording
 *      guard as the first executable statement of the ladder; the real handlers
 *      are armed at their own sites and replay a pending poke exactly once.
 *   2. The reconciler unit carries `--kill-whom=main`.
 *
 * This suite covers the pure guard, the ORDER of the wiring in the shipped
 * `main.ts` (a behavioural test cannot see a reorder inside a top-level-await
 * entry module — the same reason `cellular-boot-order.test.ts` asserts on
 * source), and the shipped unit file.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	armBootSignalHandler,
	BOOT_GUARDED_SIGNALS,
	type BootGuardedSignal,
	bootSignalGuardsInstalled,
	bootSignalPending,
	installBootSignalGuards,
	resetBootSignalGuardsForTest,
} from "../helpers/boot-signals.ts";

// src/tests -> src -> backend -> apps -> CeraUI repo root.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MAIN_TS = join(REPO_ROOT, "apps", "backend", "src", "main.ts");
const RECONCILER_UNIT = join(
	REPO_ROOT,
	"deployment",
	"ceralive-addon-reconciler.service",
);

/** A `process`-shaped double that lets a test deliver a signal on demand. */
function fakeProcess() {
	const listeners = new Map<BootGuardedSignal, Array<() => void>>();
	return {
		on(signal: BootGuardedSignal, listener: () => void) {
			const existing = listeners.get(signal) ?? [];
			existing.push(listener);
			listeners.set(signal, existing);
			return this;
		},
		deliver(signal: BootGuardedSignal) {
			for (const listener of listeners.get(signal) ?? []) listener();
		},
		listenerCount(signal: BootGuardedSignal) {
			return (listeners.get(signal) ?? []).length;
		},
	};
}

describe("boot-signal guards — the ladder is a survivable window", () => {
	beforeEach(() => {
		resetBootSignalGuardsForTest();
	});

	it("reserves EVERY guarded signal, so the terminate default can never apply", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);

		expect(bootSignalGuardsInstalled()).toBe(true);
		for (const signal of BOOT_GUARDED_SIGNALS) {
			expect(proc.listenerCount(signal)).toBe(1);
		}
	});

	it("is idempotent, so the module-scope install and the main.ts call cannot double-register", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);
		installBootSignalGuards(proc);
		installBootSignalGuards(proc);

		expect(proc.listenerCount("SIGUSR1")).toBe(1);
	});

	it("SURVIVES a SIGUSR1 that lands mid-ladder and replays it once armed", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);

		// The reconciler oneshot wins the race: the poke arrives while the boot
		// ladder is still running and nothing has armed a handler yet.
		proc.deliver("SIGUSR1");
		expect(bootSignalPending("SIGUSR1")).toBe(true);

		// …the ladder finishes and the owning subsystem arms its handler.
		let reconciles = 0;
		armBootSignalHandler("SIGUSR1", () => {
			reconciles += 1;
		});

		// The poke is neither fatal nor lost.
		expect(reconciles).toBe(1);
		expect(bootSignalPending("SIGUSR1")).toBe(false);
	});

	it("replays a mid-ladder storm exactly ONCE, not once per signal", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);

		for (let i = 0; i < 12; i += 1) proc.deliver("SIGUSR1");

		let reconciles = 0;
		armBootSignalHandler("SIGUSR1", () => {
			reconciles += 1;
		});

		expect(reconciles).toBe(1);
	});

	it("passes a post-arm signal straight through, with no pending state", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);

		let reconciles = 0;
		armBootSignalHandler("SIGUSR1", () => {
			reconciles += 1;
		});
		expect(reconciles).toBe(0);

		proc.deliver("SIGUSR1");
		proc.deliver("SIGUSR1");

		expect(reconciles).toBe(2);
		expect(bootSignalPending("SIGUSR1")).toBe(false);
	});

	it("keeps the two signals independent — a SIGUSR2 poke never arms SIGUSR1", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);

		proc.deliver("SIGUSR2");
		expect(bootSignalPending("SIGUSR2")).toBe(true);
		expect(bootSignalPending("SIGUSR1")).toBe(false);

		let hotplugs = 0;
		let reconciles = 0;
		armBootSignalHandler("SIGUSR2", () => {
			hotplugs += 1;
		});
		armBootSignalHandler("SIGUSR1", () => {
			reconciles += 1;
		});

		expect(hotplugs).toBe(1);
		expect(reconciles).toBe(0);
	});

	it("clears the pending flag BEFORE the replay, so a re-entrant handler cannot loop", () => {
		const proc = fakeProcess();
		installBootSignalGuards(proc);
		proc.deliver("SIGUSR1");

		let depth = 0;
		let maxDepth = 0;
		armBootSignalHandler("SIGUSR1", () => {
			depth += 1;
			maxDepth = Math.max(maxDepth, depth);
			// A handler that re-arms itself must not re-trigger the replay.
			if (depth < 3) {
				armBootSignalHandler("SIGUSR1", () => {
					/* replaced below */
				});
			}
			depth -= 1;
		});

		expect(maxDepth).toBe(1);
	});
});

describe("main.ts wiring — the guard is installed before the ladder", () => {
	const source = readFileSync(MAIN_TS, "utf8");

	it("installs the guard before the FIRST runCritical phase", () => {
		const install = source.indexOf("installBootSignalGuards()");
		const firstCritical = source.indexOf("await runCritical(");

		expect(install).toBeGreaterThan(-1);
		expect(firstCritical).toBeGreaterThan(-1);
		expect(install).toBeLessThan(firstCritical);
	});

	it("arms both handlers instead of registering process.on for the guarded signals", () => {
		expect(source).toContain('armBootSignalHandler("SIGUSR1"');
		expect(source).toContain('armBootSignalHandler("SIGUSR2"');

		// A re-added bare `process.on` would shadow the guard's own listener and
		// reopen the window for whichever signal it took over.
		expect(source).not.toContain('process.on("SIGUSR1"');
		expect(source).not.toContain('process.on("SIGUSR2"');
	});

	it("still arms SIGTERM/SIGINT the ordinary way — the guard is scoped to the USR pair", () => {
		expect(source).toContain('process.on("SIGTERM"');
		expect(source).toContain('process.on("SIGINT"');
	});
});

describe("ceralive-addon-reconciler.service — the poke is scoped to the main pid", () => {
	const unit = readFileSync(RECONCILER_UNIT, "utf8");
	const execLine =
		unit
			.split("\n")
			.find((line) => line.trimStart().startsWith("ExecStart=")) ?? "";

	it("targets ONLY the unit's main pid", () => {
		expect(execLine).toContain("--kill-whom=main");
		expect(execLine).toContain("--signal=SIGUSR1");
		expect(execLine).toContain("ceralive.service");
	});

	it("keeps the leading '-' so a stopped backend never fails the boot transaction", () => {
		expect(execLine).toContain("ExecStart=-/usr/bin/systemctl");
	});

	it("never falls back to a broad pkill", () => {
		expect(unit).not.toContain("pkill");
	});
});
