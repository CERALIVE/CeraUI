/**
 * The capability feature-gate framework, end to end.
 *
 * Two guarantees are asserted here, and the second one is the reason this suite
 * exists at all:
 *
 *   1. THE GATE MATRIX — off by default for all seven modules, per-modem
 *      capability gating on top of that, and the resolved claim reaching the
 *      `modems` wire so a UI can act on it.
 *   2. THE SHARED ENFORCEMENT HELPER — every mutating capability module (todos
 *      30-36) routes through `withCapabilityModuleMutation`, which must actually
 *      TAKE the mutation lease rather than merely document that it should. Each
 *      enforcement test therefore asserts BOTH the typed refusal AND that the
 *      effect provably never ran; the negative control proves the enforcement
 *      comes from the helper by showing that a module bypassing it mutates
 *      freely under exactly the same conditions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../modules/config.ts";
import {
	type ModemCapabilityEvidence,
	resolveModemCapabilityClaims,
	setModemCapabilityEvidenceReader,
} from "../modules/modems/capability-gates.ts";
import {
	capabilityMutationRefusal,
	withCapabilityModuleMutation,
} from "../modules/modems/capability-mutation.ts";
import { fromMmcliModem } from "../modules/modems/modem-wire-adapters.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import { getModems, setModem } from "../modules/modems/modems-state.ts";
import {
	listMutationEntries,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { beginModemMutation } from "../modules/modems/mutation-lease.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const IFNAME = "wwan0";
const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const KEY = ID_PATH;

const ALL_MODULES = [
	"band-lock",
	"sms",
	"five-g-pref",
	"fcc-auto-unlock",
	"gps",
	"ussd",
	"esim",
] as const;

let journalDir = "";

function evidence(partial: ModemCapabilityEvidence): void {
	setModemCapabilityEvidenceReader(() => partial);
}

/** Everything the seven modules need in order to be usable, so a test that
 *  wants to isolate ONE gate does not have to restate the rest. */
function fullyCapable(): void {
	evidence({
		capability: Object.fromEntries(
			ALL_MODULES.map((module) => [module, "present" as const]),
		),
	});
}

function enableGates(...modules: readonly string[]): void {
	getConfig().modem_capabilities = Object.fromEntries(
		modules.map((module) => [module, true]),
	);
}

async function seedModem(): Promise<void> {
	setModem(0, {
		ifname: IFNAME,
		name: "QUECTEL Broadband Module",
		sim_network: "",
		network_type: { supported: {}, active: "4g" },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "4G",
			signal: 72,
			roaming: false,
		},
		config: {
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	});
	setModemIdPathReader(() => Promise.resolve(new Map([[IFNAME, ID_PATH]])));
	await refreshModemIdPaths();
}

/** A mock mutating module. It records whether its effect actually ran. */
function mockModule() {
	const calls: string[] = [];
	return {
		calls,
		/** The SAFE shape every todo-30..36 dispatch is required to use. */
		async viaHelper(
			module: "band-lock" | "gps",
			implemented: readonly (typeof ALL_MODULES)[number][] = ALL_MODULES,
			confirmed = true,
		) {
			const request =
				module === "band-lock"
					? ({
							module: "band-lock" as const,
							stableKey: KEY,
							preState: { bands: ["any"] },
							implemented,
						} as const)
					: ({ module: "gps" as const, stableKey: KEY, implemented } as const);
			return withCapabilityModuleMutation(request, async () => {
				calls.push(module);
				return { confirmed, value: "applied" as const };
			});
		},
		/** The UNSAFE shape — the thing this framework exists to make wrong. */
		bypassingHelper() {
			calls.push("bypass");
			return "applied";
		},
	};
}

beforeEach(async () => {
	journalDir = await mkdtemp(join(tmpdir(), "ceraui-capability-journal-"));
	setMutationJournalDeps({ dir: journalDir });
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await seedModem();
});

afterEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetMutationJournalDeps();
	setModemCapabilityEvidenceReader(null);
	setModemIdPathReader(null);
	resetModemWireProducer();
	for (const id of Object.keys(getModems())) {
		delete getModems()[Number(id)];
	}
	delete getConfig().modem_capabilities;
	await rm(journalDir, { recursive: true, force: true });
});

describe("gate flags flow device-config → backend", () => {
	test("OFF BY DEFAULT: an untouched config consents to nothing", () => {
		fullyCapable();
		const claims = resolveModemCapabilityClaims(KEY, ALL_MODULES);
		for (const module of ALL_MODULES) {
			expect(claims[module]).toBe("implemented");
		}
	});

	test("a persisted gate reaches the resolved claim, and only that module", () => {
		fullyCapable();
		enableGates("band_lock");
		const claims = resolveModemCapabilityClaims(KEY, ALL_MODULES);
		expect(claims["band-lock"]).toBe("capable");
		expect(claims.gps).toBe("implemented");
	});

	test("an INCAPABLE modem with the gate ON resolves unavailable, not enabled", () => {
		evidence({ capability: { "band-lock": "absent" } });
		enableGates("band_lock");
		expect(resolveModemCapabilityClaims(KEY, ALL_MODULES)["band-lock"]).toBe(
			"unavailable",
		);
	});

	test("a throwing capability probe degrades to unknown rather than to a claim", () => {
		setModemCapabilityEvidenceReader(() => {
			throw new Error("probe blew up");
		});
		enableGates("band_lock");
		expect(resolveModemCapabilityClaims(KEY, ALL_MODULES)["band-lock"]).toBe(
			"enabled",
		);
	});
});

describe("…→ UI: the matrix reaches the modems wire", () => {
	function projectOne() {
		const modem = getModems()[0];
		if (modem === undefined) throw new Error("modem fixture missing");
		return projectModemWire([fromMmcliModem(0, modem, { idPath: ID_PATH })], {
			hasGsmAutoconfig: false,
			capabilityModulesFor: (stableKey) =>
				resolveModemCapabilityClaims(stableKey, ALL_MODULES),
		}).message["0"];
	}

	test("every row carries a TOTAL matrix, so no module can be silently omitted", () => {
		fullyCapable();
		enableGates("band_lock");
		const row = projectOne();
		expect(row?.capability_modules).toBeDefined();
		for (const module of ALL_MODULES) {
			expect(row?.capability_modules?.[module]).toBeDefined();
		}
	});

	test("the wire reports the honest state per module", () => {
		evidence({ capability: { "band-lock": "present", gps: "absent" } });
		enableGates("band_lock", "gps");
		const claims = projectOne()?.capability_modules;
		expect(claims?.["band-lock"]).toBe("capable");
		expect(claims?.gps).toBe("unavailable");
		expect(claims?.sms).toBe("implemented");
	});

	test("a projector given no resolver emits no matrix at all — the legacy wire", () => {
		const modem = getModems()[0];
		if (modem === undefined) throw new Error("modem fixture missing");
		const row = projectModemWire(
			[fromMmcliModem(0, modem, { idPath: ID_PATH })],
			{
				hasGsmAutoconfig: false,
			},
		).message["0"];
		expect(row?.capability_modules).toBeUndefined();
	});

	test("the SHIPPED producer wires the resolver — not only this test's projector", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/modem-wire-producer.ts", import.meta.url),
		).text();
		// Matched on the DEP KEY plus the resolver it reaches, not on one exact
		// spelling: the wiring legitimately grew from a bare reference into an
		// arrow that also passes the implemented list, and a literal-string lock
		// would have to be rewritten for every such change while proving no more.
		expect(source).toContain("capabilityModulesFor:");
		expect(source).toContain("resolveModemCapabilityClaims(");
	});

	test("…and the SHIPPED producer wires the 5G read block the same way", async () => {
		const source = await Bun.file(
			new URL("../modules/modems/modem-wire-producer.ts", import.meta.url),
		).text();
		expect(source).toContain("fiveGPreferenceFor:");
		expect(source).toContain("buildFiveGPreferenceView(");
	});
});

describe("the shared enforcement helper", () => {
	test("each support state maps to exactly one operator-actionable answer", () => {
		expect(capabilityMutationRefusal("implemented")).toBe("module_disabled");
		expect(capabilityMutationRefusal("enabled")).toBe("module_unavailable");
		expect(capabilityMutationRefusal("unavailable")).toBe("module_unavailable");
		expect(capabilityMutationRefusal("capable")).toBeUndefined();
		expect(capabilityMutationRefusal("certified")).toBeUndefined();
	});

	test("gate OFF: refused module_disabled, and the effect never ran", async () => {
		fullyCapable();
		const module = mockModule();
		const outcome = await module.viaHelper("band-lock");
		expect(outcome).toEqual({ ok: false, refusal: "module_disabled" });
		expect(module.calls).toEqual([]);
	});

	test("modem incapable: refused module_unavailable, and the effect never ran", async () => {
		evidence({ capability: { "band-lock": "absent" } });
		enableGates("band_lock");
		const module = mockModule();
		const outcome = await module.viaHelper("band-lock");
		expect(outcome).toEqual({ ok: false, refusal: "module_unavailable" });
		expect(module.calls).toEqual([]);
	});

	test("capability UNPROVEN fails CLOSED — an unasked question dispatches nothing", async () => {
		evidence({ capability: {} });
		enableGates("band_lock");
		const module = mockModule();
		const outcome = await module.viaHelper("band-lock");
		expect(outcome).toEqual({ ok: false, refusal: "module_unavailable" });
		expect(module.calls).toEqual([]);
	});

	test("not shipped in this build: refused, whatever the gate and the modem say", async () => {
		fullyCapable();
		enableGates("band_lock");
		const module = mockModule();
		const outcome = await module.viaHelper("band-lock", []);
		expect(outcome).toEqual({ ok: false, refusal: "module_unavailable" });
		expect(module.calls).toEqual([]);
	});

	test("IT TAKES THE LEASE: a competing mutation refuses it, and nothing ran", async () => {
		fullyCapable();
		enableGates("band_lock");
		const held = beginModemMutation(KEY);
		expect(held.ok).toBe(true);

		const module = mockModule();
		const outcome = await module.viaHelper("band-lock");
		expect(outcome).toEqual({ ok: false, refusal: "mutation_in_progress" });
		expect(module.calls).toEqual([]);
		expect(await readdir(journalDir)).toEqual([]);

		if (held.ok) held.lease.release();
	});

	test("STREAMING GUARD: an admitted stream refuses it, and nothing ran", async () => {
		fullyCapable();
		enableGates("band_lock");
		const admission = tryAcquireLifecycle("streaming");
		expect(admission.admitted).toBe(true);

		const module = mockModule();
		const outcome = await module.viaHelper("band-lock");
		expect(outcome).toEqual({ ok: false, refusal: "streaming_active" });
		expect(module.calls).toEqual([]);
	});

	test("RECIPROCAL: a stream cannot be admitted while the module is mutating", async () => {
		fullyCapable();
		enableGates("band_lock");
		let admissionDuringMutation: boolean | undefined;

		const outcome = await withCapabilityModuleMutation(
			{
				module: "band-lock",
				stableKey: KEY,
				preState: {},
				implemented: ALL_MODULES,
			},
			async () => {
				admissionDuringMutation = tryAcquireLifecycle("streaming").admitted;
				return { confirmed: true, value: null };
			},
		);

		expect(outcome.ok).toBe(true);
		expect(admissionDuringMutation).toBe(false);
		expect(tryAcquireLifecycle("streaming").admitted).toBe(true);
	});

	test("NEGATIVE CONTROL: a module that bypasses the helper mutates freely", () => {
		fullyCapable();
		enableGates("band_lock");
		const held = beginModemMutation(KEY);
		const module = mockModule();

		expect(module.bypassingHelper()).toBe("applied");
		expect(module.calls).toEqual(["bypass"]);

		if (held.ok) held.lease.release();
	});
});

describe("the helper's rollback arming", () => {
	test("a JOURNALED module arms a durable entry before the effect, and cancels it on confirm", async () => {
		fullyCapable();
		enableGates("band_lock");
		let armedDuringRun: string[] = [];

		const outcome = await withCapabilityModuleMutation(
			{
				module: "band-lock",
				stableKey: KEY,
				preState: { bands: ["any"] },
				implemented: ALL_MODULES,
			},
			async () => {
				armedDuringRun = (await listMutationEntries()).map(
					(entry) => entry.kind,
				);
				return { confirmed: true, value: "ok" };
			},
		);

		expect(outcome).toEqual({ ok: true, value: "ok" });
		expect(armedDuringRun).toEqual(["band-lock"]);
		expect(await listMutationEntries()).toEqual([]);
	});

	test("an UNCONFIRMED journaled mutation stays failed, fail-closed", async () => {
		fullyCapable();
		enableGates("band_lock");
		const module = mockModule();

		await module.viaHelper("band-lock", ALL_MODULES, false);

		const entries = await listMutationEntries();
		expect(entries.map((entry) => entry.state)).toEqual(["failed"]);
		expect(entries[0]?.preState).toEqual({ bands: ["any"] });
	});

	test("a LEASE-ONLY module takes the lease and journals nothing", async () => {
		fullyCapable();
		enableGates("gps");
		const module = mockModule();

		const outcome = await module.viaHelper("gps");
		expect(outcome).toEqual({ ok: true, value: "applied" });
		expect(module.calls).toEqual(["gps"]);
		expect(await readdir(journalDir)).toEqual([]);
	});
});
