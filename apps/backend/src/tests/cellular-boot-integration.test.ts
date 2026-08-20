/*
    CeraUI - cellular BOOT-INTEGRATION suite.

    Todos 20-24 each proved their own module in isolation, thoroughly. This suite
    deliberately does NOT repeat any of that. It asks the one question a unit
    test structurally cannot: when the real boot statements run in the real
    order, against the real mock scenario, does the result reach the wire?

    That question has a precedent and a scar. `tests/mock-sources-parity.test.ts`
    exists because todo 21's 36-case suite stayed green for a whole wave while
    `modes[]` was silently dropped by `probeEngineDevices`'s whitelist copy — the
    unit tests handed `buildSources` a hand-built literal and never crossed the
    seam that lost the field. `bootLikeCellular` below is the cellular twin of
    its `bootLikeMain`: mock fixtures in at one end, the REAL composition root,
    the REAL dongle reader, the REAL projection, and the actual
    `buildModemsWireMessage()` payload asserted at the other.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { modemListSchema } from "@ceraui/rpc/schemas";

import { guardNonCritical } from "../helpers/boot-guard.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	getMockDbusModemViews,
	getMockModemIdPaths,
} from "../mocks/providers/cellular.ts";
import {
	assertCellularStackReady,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import {
	peekShadowSession,
	resetModemShadow,
	startModemShadowIfEnabled,
	stopModemShadow,
} from "../modules/cellular/shadow.ts";
import { getConfig } from "../modules/config.ts";
import {
	buildModemsMessage,
	buildModemsWireMessage,
} from "../modules/modems/modem-status.ts";
import { discoverModems } from "../modules/modems/modem-update-loop.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setMockDbusModemViews,
} from "../modules/modems/modem-wire-producer.ts";
import { getModemIds, removeModem } from "../modules/modems/modems-state.ts";
import {
	refreshDongleMetadata,
	resetDongleMetadata,
} from "../modules/network/dongle-metadata.ts";

const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

const silent = { error: () => undefined, warn: () => undefined };

interface BootOptions {
	readonly backend?: "mmcli" | "dbus";
	readonly shadow?: boolean;
	/** Drive the `{ok:false}` arm — a resolved list that is NOT a commit. */
	readonly failDbusBackend?: boolean;
}

/**
 * Run the cellular slice of `main.ts` — the SAME two `guardNonCritical` calls,
 * in the SAME order, ahead of the same modem discovery the update loop performs.
 *
 * `discoverModems()` (not a hand-seeded state map) is what makes this a boot
 * test: it is the function `initModemUpdateLoop` calls first, and under mocks it
 * routes through the real `mmcli.ts` parser via the mock mmcli provider. The
 * loop's timers and monitor are deliberately NOT started — this suite is about
 * the boot ORDER and the resulting payload, not the retained poll.
 */
async function bootLikeCellular(
	scenario: string,
	options: BootOptions = {},
): Promise<void> {
	process.env.MOCK_MODE = "true";
	process.env.MOCK_SCENARIO = scenario;
	initMockService(scenario);

	const config = getConfig() as Record<string, unknown>;
	if (options.backend === undefined) delete config.modem_backend;
	else config.modem_backend = options.backend;
	if (options.shadow === true) config.modem_shadow = true;
	else delete config.modem_shadow;

	// main.ts's dev block installs this before any guard runs.
	setMockDbusModemViews(getMockDbusModemViews);

	const startStack =
		options.failDbusBackend === true
			? () =>
					initCellularStack({
						createDbusBackend: () => ({
							start: async () => ({ ok: false }),
							stop: async (): Promise<void> => undefined,
						}),
					})
			: initCellularStack;

	await guardNonCritical("cellular-stack", startStack, { logger: silent });
	await guardNonCritical("cellular-shadow", startModemShadowIfEnabled, {
		logger: silent,
	});

	await discoverModems();
	// The netif poll's job on a real device; the fixtures cross the REAL reader.
	await refreshDongleMetadata();
	await refreshModemIdPaths();
}

function clearModems(): void {
	for (const id of getModemIds()) removeModem(id);
}

/**
 * The wire with `status.signal` dropped.
 *
 * The mock scenario fluctuates signal on a timer to make the dev UI move, so a
 * raw `JSON.stringify` compare across two boots is flaky BY DESIGN of the
 * fixture — and reading that flake as "shadow changed the wire" is precisely the
 * wrong conclusion. Every other field, including the whole additive block and
 * the key ORDER, is still compared byte-for-byte.
 */
function stableWire(): string {
	const wire = buildModemsWireMessage();
	return JSON.stringify(wire, (key, value) =>
		key === "signal" ? undefined : value,
	);
}

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	clearModems();
	resetCellularStack();
	resetModemShadow();
	resetDongleMetadata();
	resetModemWireProducer();
});

afterEach(async () => {
	await stopModemShadow();
	stopMockService();
	clearModems();
	resetCellularStack();
	resetModemShadow();
	resetDongleMetadata();
	resetModemWireProducer();
	const config = getConfig() as Record<string, unknown>;
	delete config.modem_backend;
	delete config.modem_shadow;
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("cellular boot — the additive fields reach the wire", () => {
	/**
	 * THE parity assertion. `stable_key` is produced by the composition root
	 * (`refreshModemIdPaths` → the mmcli adapter's `idPath`), not by any module
	 * todo 22 tested — so this is exactly the seam a unit test cannot see, and
	 * exactly the seam `modes[]` was lost at.
	 */
	test("every mmcli modem row carries a stable_key derived from its ID_PATH", async () => {
		await bootLikeCellular("multi-modem-wifi");

		const wire = buildModemsWireMessage();
		const rows = Object.values(wire);
		expect(rows.length).toBeGreaterThan(0);

		const idPaths = getMockModemIdPaths();
		expect(idPaths.size).toBeGreaterThan(0);
		const expectedKeys = new Set(
			[...idPaths.values()].map((p) => p.slice(0, p.lastIndexOf(":"))),
		);

		for (const row of rows) {
			if (row.device_class === "router-ethernet") continue;
			expect(typeof row.stable_key).toBe("string");
			// The fixture supplies the `:1.2` NET-INTERFACE path; the wire must
			// carry the parent `usb_device` it strips back to. Asserting the
			// stripped SET (not merely "a string") is what proves the shared
			// `deriveModemStableKey` ran rather than the raw path being copied.
			expect([...idPaths.values()]).not.toContain(row.stable_key);
			expect(expectedKeys.has(row.stable_key ?? "")).toBe(true);
		}
	});

	test("the legacy builder still emits no additive field at all", async () => {
		await bootLikeCellular("multi-modem-wifi");

		for (const row of Object.values(buildModemsMessage())) {
			expect(Object.hasOwn(row, "stable_key")).toBe(false);
			expect(Object.hasOwn(row, "device_class")).toBe(false);
		}
	});

	/**
	 * A row the projection ADDS must be schema-valid, or the two pull procedures
	 * (`modems.get`, `status.get`) throw on `modemListSchema.parse` and the
	 * operator loses the whole modem surface rather than one row.
	 */
	test("the projected message is schema-valid through the real parse", async () => {
		await bootLikeCellular("multi-modem-wifi");
		expect(modemListSchema.safeParse(buildModemsWireMessage()).success).toBe(
			true,
		);
	});

	test("a status-only broadcast stays status-only after projection", async () => {
		await bootLikeCellular("multi-modem-wifi");

		const partial = buildModemsWireMessage({});
		const mmRows = Object.entries(partial).filter(
			([, row]) => row.device_class !== "router-ethernet",
		);
		expect(mmRows.length).toBeGreaterThan(0);
		for (const [, row] of mmRows) {
			// No identity on a partial — including no stable_key.
			expect(Object.keys(row)).toEqual(["status"]);
		}
	});
});

describe("cellular boot — dongle rows", () => {
	test("both mock dongles reach the wire as honest router-ethernet rows", async () => {
		await bootLikeCellular("multi-modem-wifi");

		const rows = Object.values(buildModemsWireMessage()).filter(
			(row) => row.device_class === "router-ethernet",
		);
		expect(rows.length).toBe(2);

		const up = rows.find((r) => r.slot_label === "dongle0");
		const acquiring = rows.find((r) => r.slot_label === "dongle1");
		expect(up?.availability_reason).toBe("router_managed");
		expect(acquiring?.availability_reason).toBe("dongle_acquiring");

		for (const row of rows) {
			// The three deliberate omissions — a dongle publishes no radio
			// telemetry, so a zeroed status block would render as "no signal" on a
			// device that is carrying traffic.
			expect(row.status).toBeUndefined();
			expect(row.config).toBeUndefined();
			expect(row.no_sim).toBeUndefined();
			expect(row.available_networks).toBeUndefined();
			expect(JSON.stringify(row)).not.toContain("signal");
		}
	});

	test("dongle rows take synthetic ids from the reserved floor, never an MM id", async () => {
		await bootLikeCellular("multi-modem-wifi");

		const wire = buildModemsWireMessage();
		const dongleIds = Object.entries(wire)
			.filter(([, row]) => row.device_class === "router-ethernet")
			.map(([id]) => Number(id));
		expect(dongleIds.length).toBe(2);
		for (const id of dongleIds) expect(id).toBeGreaterThanOrEqual(1000);

		const mmIds = getModemIds();
		for (const id of dongleIds) expect(mmIds).not.toContain(id);
	});

	/**
	 * The projector refuses to own the allocation map; the producer retains it.
	 * Drop that round-trip and every 30 s poll renumbers the dongles under the
	 * operator, which is the one thing a wire id must never do.
	 */
	test("a dongle keeps its synthetic id across repeated builds", async () => {
		await bootLikeCellular("multi-modem-wifi");

		const idsOf = () =>
			Object.entries(buildModemsWireMessage())
				.filter(([, row]) => row.device_class === "router-ethernet")
				.map(([id, row]) => `${row.slot_label}=${id}`)
				.sort();

		const first = idsOf();
		expect(idsOf()).toEqual(first);
		expect(idsOf()).toEqual(first);
	});
});

describe("cellular boot — backend selection is what the wire follows", () => {
	test("the mmcli ROLLBACK value boots mmcli and emits no D-Bus-only detail", async () => {
		await bootLikeCellular("multi-modem-wifi", { backend: "mmcli" });

		expect(getCellularStack().backend).toBe("mmcli");
		for (const row of Object.values(buildModemsWireMessage())) {
			if (row.device_class === "router-ethernet") continue;
			expect(row.usb_mode).toBeUndefined();
			expect(row.cell_info).toBeUndefined();
			expect(row.data_usage).toBeUndefined();
		}
	});

	test("a dbus-configured device emits the additive detail block", async () => {
		await bootLikeCellular("multi-modem-wifi", { backend: "dbus" });

		// Asserted, NOT derived. Reading `detailExpected` off the live stack made
		// this test pass vacuously while the dev backend could only ever fall
		// back — the whole D-Bus surface was unreachable and the suite said so in
		// green. The commit must be positively proven before anything is claimed
		// about the rows it produced.
		const stack = getCellularStack();
		expect(stack).toEqual({ backend: "dbus", ready: true, degraded: false });

		const rows = Object.values(buildModemsWireMessage()).filter(
			(row) => row.device_class !== "router-ethernet",
		);
		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			expect(row.usb_mode).toBe("mbim");
			expect(row.firmware_revision).toContain("MOCK01");
			expect(row.cell_info).toBeDefined();
			expect(row.data_usage).toBeDefined();
			// The legacy half must still be indistinguishable from an mmcli row.
			expect(row.status?.network_type).toMatch(/^[45]G$/);
			expect(typeof row.stable_key).toBe("string");
		}
	});

	/**
	 * The other direction, and the one that matters on real hardware today: a
	 * `dbus` request whose backend does NOT commit degrades to mmcli, and mmcli
	 * observes none of the additive detail. Advertising it anyway would put a
	 * confident value on the wire that nothing measured.
	 */
	test("a dbus request that FALLS BACK projects mmcli rows, detail-free", async () => {
		await bootLikeCellular("multi-modem-wifi", {
			backend: "dbus",
			failDbusBackend: true,
		});

		const stack = getCellularStack();
		expect(stack.backend).toBe("mmcli");
		expect(stack.degraded).toBe(true);

		const rows = Object.values(buildModemsWireMessage()).filter(
			(row) => row.device_class !== "router-ethernet",
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(Object.hasOwn(row, "usb_mode")).toBe(false);
			expect(Object.hasOwn(row, "cell_info")).toBe(false);
			expect(Object.hasOwn(row, "firmware_revision")).toBe(false);
			// …but the operator still has a working modem list.
			expect(row.ifname).toBeDefined();
			expect(row.status).toBeDefined();
		}
	});

	/**
	 * The NM profile is NOT a ModemManager fact, so the fold cannot observe it —
	 * and because the wire block is OPTIONAL, its absence broke nothing loudly.
	 * What it broke quietly is the dialog's configure-echo, which returns `false`
	 * on a missing config, so a save the device ACCEPTED could never be confirmed
	 * and the spinner ran to its TTL. Board-measured on a Quectel RM530N-GL.
	 */
	test("a dbus row carries the NM connection profile the mmcli row carries", async () => {
		await bootLikeCellular("multi-modem-wifi", { backend: "mmcli" });
		const viaMmcli = Object.fromEntries(
			Object.entries(buildModemsWireMessage())
				.filter(([, row]) => row.config !== undefined)
				.map(([id, row]) => [id, row.config]),
		);
		// The fixture must actually provision a profile, or this proves nothing.
		expect(Object.keys(viaMmcli).length).toBeGreaterThan(0);

		clearModems();
		resetCellularStack();
		resetModemWireProducer();
		await bootLikeCellular("multi-modem-wifi", { backend: "dbus" });
		expect(getCellularStack()).toEqual({
			backend: "dbus",
			ready: true,
			degraded: false,
		});

		const viaDbus = buildModemsWireMessage();
		for (const [id, config] of Object.entries(viaMmcli)) {
			expect(viaDbus[id]?.config).toEqual(config);
		}
	});

	/**
	 * The other half of the join's contract: a modem the mmcli side holds no
	 * profile for stays ABSENT. An empty block would render in the dialog as a
	 * real, blank profile and invite a save against a connection that is not
	 * provisioned yet.
	 */
	test("a modem with no NM profile is left without a config block", async () => {
		await bootLikeCellular("multi-modem-wifi", { backend: "dbus" });
		// The D-Bus views are independent of the mmcli state map, so dropping the
		// map leaves the SAME rows with nothing to join a profile from.
		clearModems();

		const rows = Object.values(buildModemsWireMessage()).filter(
			(row) => row.device_class !== "router-ethernet",
		);
		for (const row of rows) {
			expect(Object.hasOwn(row, "config")).toBe(false);
		}
	});
});

/**
 * The WINDOW is the whole reason the boot order is what it is, and it is the one
 * thing no unit test can show: `initCellularStack` publishes `{ready:false}`
 * SYNCHRONOUSLY and only commits after an awaited backend start, so between
 * those two moments every modem procedure refuses. Ordering the modem loop ahead
 * of the stack does not remove that window — it moves the operator's first
 * `modems` broadcast into it.
 */
describe("cellular boot — the refusal window the order exists to close", () => {
	test("the gate refuses while a dbus stack is mid-init, and passes once committed", async () => {
		process.env.MOCK_MODE = "true";
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
		initMockService("multi-modem-wifi");
		(getConfig() as Record<string, unknown>).modem_backend = "dbus";

		let release: (() => void) | undefined;
		const gateInFlight = new Promise<void>((resolve) => {
			release = resolve;
		});

		const booting = initCellularStack({
			createDbusBackend: () => ({
				start: async () => {
					await gateInFlight;
					return { ok: true };
				},
				stop: async (): Promise<void> => undefined,
			}),
		});

		expect(getCellularStack().ready).toBe(false);
		expect(() => assertCellularStackReady()).toThrow();

		release?.();
		await booting;

		expect(getCellularStack().ready).toBe(true);
		expect(() => assertCellularStackReady()).not.toThrow();
	});

	test("an mmcli device has NO such window — the stack is ready synchronously", async () => {
		process.env.MOCK_MODE = "true";
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
		initMockService("multi-modem-wifi");

		const booting = initCellularStack({ backend: "mmcli" });
		// Not awaited yet: the mmcli arm must commit before its first await.
		expect(getCellularStack().ready).toBe(true);
		expect(() => assertCellularStackReady()).not.toThrow();
		await booting;
	});
});

describe("cellular boot — shadow mode", () => {
	test("an unconfigured device never starts shadow", async () => {
		await bootLikeCellular("multi-modem-wifi");
		expect(peekShadowSession()).toBeUndefined();
	});

	/**
	 * The dev fixture diverges on `registration` DELIBERATELY. A zero-divergence
	 * fixture would be the useless one: the retirement gate is read entirely off
	 * divergence records, so a developer has to be able to watch one being
	 * classified without a second physical modem.
	 */
	test("modem_shadow=true starts a session that classifies the seeded divergence", async () => {
		await bootLikeCellular("multi-modem-wifi", { shadow: true });

		const session = peekShadowSession();
		expect(session).toBeDefined();
		expect(session?.refusals).toBe(0);
		expect(session?.divergences.length).toBeGreaterThan(0);
	});

	test("shadow never disturbs the wire", async () => {
		await bootLikeCellular("multi-modem-wifi");
		const withoutShadow = stableWire();

		await stopModemShadow();
		resetModemShadow();
		clearModems();
		resetDongleMetadata();
		resetModemWireProducer();
		resetCellularStack();
		await bootLikeCellular("multi-modem-wifi", { shadow: true });

		expect(stableWire()).toBe(withoutShadow);
	});
});
