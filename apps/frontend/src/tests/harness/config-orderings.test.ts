// @vitest-environment jsdom
/**
 * A setting while its tab's link is replaced, in every order the login snapshot
 * (S), the reconnect pull's answer (P) and a field lock (L) can land.
 *
 * The real client and store run on a scripted socket; each case places the
 * three events itself, so nothing races. Two things must hold in every order: a
 * write still in flight keeps its value on screen, and once its lock lets go
 * the tab shows exactly what the device last reported. The snapshot is the
 * whole config; the pull never speaks for `autostart` or `country`.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("$lib/env", () => ({ getRpcSocketUrl: () => "ws://test.local/ws" }));

import {
	COMPILE_MS,
	compileTab,
	flushReplies,
	resetTab,
	start,
} from "./scripted-socket";

const FIELD_LOCK_TTL_MS = 10_000;

/** What the tab showed for the key before the drop, and what another tab set. */
const HELD = 6000;
const OTHER = 5000;
const ABSENT = undefined;

type Lock = "value" | "clear" | "answered";
type Device = "omits" | "older" | "other" | "cleared between";

/** The key in the first and in the second answer to arrive. */
const REPORTS: Record<
	Device,
	readonly [number | undefined, number | undefined]
> = {
	omits: [ABSENT, ABSENT],
	older: [HELD, HELD],
	other: [OTHER, OTHER],
	"cleared between": [HELD, ABSENT],
};

/** The key right after the last event, for a lock placed BEFORE any answer. */
const LOCKED_FIRST: Record<Lock, Record<Device, number | undefined>> = {
	// In flight: kept, whatever the device says.
	value: { omits: HELD, older: HELD, other: HELD, "cleared between": HELD },
	// A clear: an absent key is its answer; a listed one is a stale echo.
	clear: { omits: ABSENT, older: HELD, other: HELD, "cleared between": ABSENT },
	// Answered (or its link dropped): an absent key is the device's word.
	answered: {
		omits: ABSENT,
		older: HELD,
		other: HELD,
		"cleared between": ABSENT,
	},
};

/** The same for a lock placed BETWEEN the two answers: the first one stands. */
const LOCKED_BETWEEN: Record<Lock, Record<Device, number | undefined>> = {
	value: { omits: ABSENT, older: HELD, other: OTHER, "cleared between": HELD },
	clear: {
		omits: ABSENT,
		older: HELD,
		other: OTHER,
		"cleared between": ABSENT,
	},
	answered: {
		omits: ABSENT,
		older: HELD,
		other: OTHER,
		"cleared between": ABSENT,
	},
};

const lastReport = (device: Device) => REPORTS[device][1];

function shown(
	key: number | undefined,
	country: string | undefined,
): Record<string, unknown> {
	return {
		source: "cam-1",
		autostart: true,
		...(key === undefined ? {} : { max_br: key }),
		...(country === undefined ? {} : { country }),
	};
}

async function play(order: string, lock: Lock, device: Device) {
	const { markPending, onRpcResolved } = await import(
		"$lib/rpc/dirty-registry.svelte"
	);
	const { first, replace, signIn, subscriptions } = await start();
	await signIn();
	first.push({
		config: { source: "cam-1", max_br: HELD, autostart: true, country: "BO" },
		seq: 1,
	});
	const place: Record<string, () => Promise<void> | void> = {
		L: () => {
			markPending("max_br", lock === "clear" ? null : 8000);
			if (lock === "answered") onRpcResolved("max_br");
		},
	};
	const reports = [...REPORTS[device]];
	const report = () => {
		const value = reports.shift();
		return {
			source: "cam-1",
			...(value === undefined ? {} : { max_br: value }),
		};
	};
	const events = [...order];
	if (events[0] === "L") await place[events.shift() ?? ""]?.();
	// Offline: another tab cleared `country` and maybe changed the key.
	const second = replace(first);
	second.reply("auth.login", { success: true });
	await flushReplies();
	place.S = async () =>
		second.push({ config: { ...report(), autostart: true } });
	place.P = async () => {
		second.reply("streaming.getConfig", report());
		await flushReplies();
	};
	for (const event of events) await place[event]?.();
	return { subscriptions, second };
}

beforeAll(compileTab, COMPILE_MS);

beforeEach(resetTab);

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const LOCKS: Lock[] = ["value", "clear", "answered"];
const DEVICES: Device[] = ["omits", "older", "other", "cleared between"];

for (const order of ["LSP", "LPS", "SLP", "PLS", "SPL", "PSL"]) {
	for (const lock of LOCKS) {
		for (const device of DEVICES) {
			it(`${order}, lock: ${lock}, device: ${device}`, async () => {
				const { subscriptions } = await play(order, lock, device);

				const at = order.indexOf("L");
				const now =
					at === 0
						? LOCKED_FIRST[lock][device]
						: at === 1
							? LOCKED_BETWEEN[lock][device]
							: lastReport(device);
				expect(subscriptions.getConfig()).toEqual(shown(now, ABSENT));
				// Ticks that find the lock still there change nothing.
				await vi.advanceTimersByTimeAsync(2_000);
				expect(subscriptions.getConfig()).toEqual(shown(now, ABSENT));

				await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS);
				expect(subscriptions.getConfig()).toEqual(
					shown(lastReport(device), ABSENT),
				);
			});
		}
	}
}

describe("only one of the two answers arrives", () => {
	for (const order of ["LS", "SL", "LP", "PL"]) {
		// Without the snapshot nothing on this link speaks for `country`.
		const country = order.includes("S") ? ABSENT : "BO";
		for (const lock of LOCKS) {
			for (const device of ["omits", "older", "other"] as const) {
				it(`${order}, lock: ${lock}, device: ${device}`, async () => {
					const { subscriptions } = await play(order, lock, device);

					const now =
						order[0] === "L" ? LOCKED_FIRST[lock][device] : lastReport(device);
					expect(subscriptions.getConfig()).toEqual(shown(now, country));
					await vi.advanceTimersByTimeAsync(2_000);
					expect(subscriptions.getConfig()).toEqual(shown(now, country));

					await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS);
					expect(subscriptions.getConfig()).toEqual(
						shown(lastReport(device), country),
					);
				});
			}
		}
	}
});

describe("on one link", () => {
	it("a value another tab set while this tab's write was in flight is shown once the lock lets go", async () => {
		const { markPending } = await import("$lib/rpc/dirty-registry.svelte");
		const { first, signIn, subscriptions } = await start();
		await signIn();
		first.push({ config: { source: "cam-1", max_br: HELD }, seq: 1 });
		markPending("max_br", 8000);

		first.push({ config: { source: "cam-1", max_br: OTHER }, seq: 2 });
		expect(subscriptions.getConfig()?.max_br).toBe(HELD);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(subscriptions.getConfig()?.max_br).toBe(HELD);

		await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS);
		expect(subscriptions.getConfig()?.max_br).toBe(OTHER);
	});

	it("a write's own echo after a differing one is what stays", async () => {
		const { markPending, onRpcResolved } = await import(
			"$lib/rpc/dirty-registry.svelte"
		);
		const { first, signIn, subscriptions } = await start();
		await signIn();
		first.push({ config: { source: "cam-1", max_br: HELD }, seq: 1 });
		markPending("max_br", 8000);
		first.push({ config: { source: "cam-1", max_br: OTHER }, seq: 2 });

		first.push({ config: { source: "cam-1", max_br: 8000 }, seq: 3 });
		onRpcResolved("max_br");
		await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS + 2_000);

		expect(subscriptions.getConfig()?.max_br).toBe(8000);
	});

	it("a bitrate push after a differing echo is what stays", async () => {
		const { markPending, onRpcResolved } = await import(
			"$lib/rpc/dirty-registry.svelte"
		);
		const { first, signIn, subscriptions } = await start();
		await signIn();
		first.push({ config: { source: "cam-1", max_br: HELD }, seq: 1 });
		markPending("max_br", 8000);
		first.push({ config: { source: "cam-1", max_br: OTHER }, seq: 2 });

		first.push({ bitrate: { max_br: 7000 }, seq: 1 });
		onRpcResolved("max_br");
		await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS + 2_000);

		expect(subscriptions.getConfig()?.max_br).toBe(7000);
	});

	it("a clear after a differing echo is what stays", async () => {
		const { markPending } = await import("$lib/rpc/dirty-registry.svelte");
		const { first, signIn, subscriptions } = await start();
		await signIn();
		first.push({ config: { source: "cam-1", max_br: HELD }, seq: 1 });
		markPending("max_br", 8000);
		first.push({ config: { source: "cam-1", max_br: OTHER }, seq: 2 });

		first.push({ config: { source: "cam-1" }, seq: 3 });
		first.push({ config_clear: { keys: ["max_br"] }, seq: 1 });
		await vi.advanceTimersByTimeAsync(FIELD_LOCK_TTL_MS + 2_000);

		expect(subscriptions.getConfig()).toEqual({ source: "cam-1" });
	});

	it("a clear made while this tab was signed out on the same socket is shown after it signs in again", async () => {
		const { auth, first, signIn, subscriptions } = await start();
		await signIn();
		first.push({
			config: { source: "cam-1", max_br: HELD, country: "BO" },
			seq: 1,
		});

		// The saved session was retired in place: no frame reaches this socket.
		auth.setAuthStatus(false);
		await signIn();
		first.push({ config: { source: "cam-1" } });

		expect(subscriptions.getConfig()).toEqual({ source: "cam-1" });
	});

	it("after the snapshot and the pull, a frame that omits a key leaves it unchanged", async () => {
		const { subscriptions, second } = await play("SP", "value", "older");

		second.push({ config: { source: "cam-2" }, seq: 1 });

		expect(subscriptions.getConfig()).toEqual({
			source: "cam-2",
			max_br: HELD,
			autostart: true,
		});
	});

	it("a later config frame that omits a key still leaves it unchanged", async () => {
		const { first, signIn, subscriptions } = await start();
		await signIn();
		first.push({ config: { source: "cam-1", max_br: HELD } });

		first.push({ config: { source: "cam-2" }, seq: 1 });

		expect(subscriptions.getConfig()).toEqual({
			source: "cam-2",
			max_br: HELD,
		});
	});
});
