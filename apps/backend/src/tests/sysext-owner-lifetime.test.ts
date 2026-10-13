import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import {
	currentSysextOperation,
	runDisruptiveSysextStep,
} from "../modules/addons/disruptive-sysext-step.ts";
import {
	enableAddon,
	resolveActiveAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import {
	addonRefusalBaseline,
	withAddonMutation,
	withAddonRefusalBaseline,
} from "../modules/addons/mutation.ts";
import { getAddons, getConfig } from "../modules/config.ts";
import {
	getKioskStatus,
	kioskStart,
	kioskStop,
	resolveActiveKioskDeps,
	setKioskDeps,
} from "../modules/system/kiosk.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { heldBoundary, sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
let tick: () => void;
let registrationIdentity: string | undefined;
const realInterval = globalThis.setInterval;
const intervalDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"setInterval",
);
async function jobs(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}
beforeEach(() => {
	f = sysextTailFixture();
	Object.defineProperty(globalThis, "setInterval", {
		configurable: true,
		value: (callback: Bun.TimerHandler, ms?: number) => {
			// Inject the clock, retaining actual async-resource inheritance at registration.
			expect(ms).toBe(2000);
			registrationIdentity = currentSysextOperation()?.name;
			const resource = new AsyncResource("injected-kiosk-interval");
			if (typeof callback !== "function")
				throw new Error("poll callback must be callable");
			tick = () => resource.runInAsyncScope(() => callback());
			return realInterval(() => undefined, 86_400_000);
		},
	});
});
afterEach(() => {
	f.reset();
	if (!intervalDescriptor) throw new Error("missing interval descriptor");
	Object.defineProperty(globalThis, "setInterval", intervalDescriptor);
});

test("a kiosk poll started by Start cannot run under a released owner", async () => {
	// Given the REAL Start-created interval and an observation held after Start returns.
	const held = heldBoundary();
	let pollIdentity: string | undefined;
	setKioskDeps({
		...resolveActiveKioskDeps(),
		isActive: async () => {
			pollIdentity = currentSysextOperation()?.name;
			await held.wait();
			return true;
		},
	});
	await kioskStart();
	expect(registrationIdentity).toBeUndefined();
	tick();
	await held.entered;
	let stopped = false;
	const stop = kioskStop().then(() => {
		stopped = true;
	});
	// When Stop queues behind the poll, without a shortened real timer.
	await jobs();
	const completedBeforeRelease = stopped;
	held.release();
	await stop;
	await jobs();
	// Then Stop owns final intent and no old operation identity survives.
	expect(completedBeforeRelease).toBe(false);
	expect(pollIdentity).toBeUndefined();
	expect(getKioskStatus()).toMatchObject({ enabled: false, state: "disabled" });
	expect(getConfig().kiosk_last_state).toBe("disabled");
});

test("a timer descendant never bypasses a live same-id mutation", async () => {
	// Given an old interval and a newer enable held under the cog-display mutex.
	const held = heldBoundary();
	let probes = 0;
	setKioskDeps({
		...resolveActiveKioskDeps(),
		isFailed: async () => {
			probes++;
			return true;
		},
		getNRestarts: async () => 3,
		systemctl: async () => ({ stdout: "", stderr: "" }),
	});
	await kioskStart();
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		verify: () => held.wait(),
	});
	const enable = enableAddon(sysextDescriptor);
	await held.entered;
	// When the old timer fires while the new mutation owns verification.
	tick();
	await jobs();
	const earlyProbes = probes;
	held.release();
	await enable;
	await withAddonMutation("cog-display", async () => undefined);
	await jobs();
	// Then safety runs AFTER enable and cannot be overwritten by its tail.
	expect(earlyProbes).toBe(0);
	expect(getAddons()["cog-display"]).toMatchObject({
		enabled: false,
		phase: "error",
		autoDisabled: true,
		lastError: "addon_crash_loop",
	});
});

test("an escaped async descendant must reacquire ownership after its operation ends", async () => {
	// Given a descendant deliberately carrying old ALS tokens, unlike detached kiosk timers.
	let descendant: AsyncResource | undefined;
	await withAddonMutation("escaped", () =>
		withAddonRefusalBaseline({ id: "escaped", state: undefined }, () =>
			runDisruptiveSysextStep("expired", async () => {
				descendant = new AsyncResource("escaped-owner");
			}),
		),
	);
	const held = heldBoundary();
	const owner = withAddonMutation("escaped", () => held.wait());
	await held.entered;
	const effects: string[] = [];
	if (!descendant) throw new Error("missing captured resource");
	const identity = descendant.runInAsyncScope(currentSysextOperation);
	const baseline = descendant.runInAsyncScope(() =>
		addonRefusalBaseline("escaped"),
	);
	// When an inherited token is used after release under a competing owner.
	const next = descendant.runInAsyncScope(() =>
		withAddonMutation("escaped", async () => {
			effects.push("next");
		}),
	);
	await jobs();
	const earlyEffects = [...effects];
	held.release();
	await owner;
	await next;
	// Then identity/baseline are retired and the current owner cannot be bypassed.
	expect(identity).toBeUndefined();
	expect(baseline).toBeUndefined();
	expect(earlyEffects).toEqual([]);
	expect(effects).toEqual(["next"]);
	descendant.emitDestroy();
});
