/**
 * Runtime enablement (a) + the boot reconciler (b2).
 *
 * The three claims this file exists to hold:
 *
 *  1. The unit is `bluealsa.service`. `bluealsad` is the BINARY, and the wrong
 *     name fails in the direction that is invisible — a device that pairs a
 *     headset and can never open its microphone. Asserted against the exact
 *     string, and against the absence of the binary name anywhere a unit is
 *     expected.
 *  2. Disable is PERSISTENT-SYMMETRIC. A stop-only disable leaves the units
 *     enabled and the operator's choice reverses itself at the next reboot, so
 *     the argv is asserted verb-for-verb in BOTH directions.
 *  3. The reconciler re-applies BOTH directions and never throws.
 *
 * Every seam is injected: no test here touches a real systemctl, a real
 * filesystem, or a real bus.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { detectBluetoothAudioProvider } from "../modules/bluetooth/bluetooth-audio-provider.ts";
import {
	BLUEALSA_BINARIES,
	BLUEALSA_DROPIN_PATH,
	BLUEALSA_PACKAGE_MARKER,
	BLUEALSA_UNIT,
	BLUETOOTH_UNIT,
	BLUETOOTH_UNITS,
	PIPEWIRE_BLUETOOTH_PACKAGE_MARKER,
} from "../modules/bluetooth/bluetooth-constants.ts";
import {
	isPersistentlyEnabled,
	parseBluealsaHelp,
	parseUnitActiveState,
	parseUnitEnabledState,
} from "../modules/bluetooth/bluetooth-parsers.ts";
import { createMemoryPreferenceStore } from "../modules/bluetooth/bluetooth-preference.ts";
import {
	type BluetoothServicesDeps,
	buildBluealsaDropIn,
	type CommandResult,
	ensureBluealsaDropIn,
	reconcileBluetoothServices,
	resetBluetoothServiceReconcileForTest,
	setBluetoothEnabled,
} from "../modules/bluetooth/bluetooth-services.ts";

const BLUEALSA_HELP = [
	"Usage:",
	"  bluealsad -p PROFILE [OPTION]...",
	"Options:",
	"  -p, --profile=NAME\tenable BT profile",
	"  -c, --codec=NAME\tenable BT audio codec",
	"Available BT profiles:",
	"  - a2dp-source, a2dp-sink, hfp-ag, hfp-hf, hsp-ag, hsp-hs",
	"Available BT audio codecs:",
	"  a2dp-source: sbc",
	"  hfp-*: cvsd, msbc",
].join("\n");

const BLUEALSA_HELP_NARROWBAND = BLUEALSA_HELP.replace(", msbc", "");

interface Harness {
	deps: BluetoothServicesDeps;
	calls: string[][];
	writes: Array<{ path: string; contents: string }>;
	warnings: string[];
	files: Map<string, string>;
}

function harness(
	options: {
		readonly real?: boolean;
		readonly enabledState?: string;
		readonly activeState?: string;
		readonly help?: string;
		readonly binaries?: readonly string[];
		readonly preference?: { enabled: boolean };
	} = {},
): Harness {
	const calls: string[][] = [];
	const writes: Array<{ path: string; contents: string }> = [];
	const warnings: string[] = [];
	const files = new Map<string, string>();
	const binaries = new Set(options.binaries ?? ["/usr/bin/bluealsad"]);

	const systemctl = async (args: readonly string[]): Promise<CommandResult> => {
		calls.push([...args]);
		if (args[0] === "is-enabled") {
			return {
				exitCode: 0,
				stdout: `${options.enabledState ?? "disabled"}\n`,
				stderr: "",
			};
		}
		if (args[0] === "is-active") {
			return {
				exitCode: 0,
				stdout: `${options.activeState ?? "inactive"}\n`,
				stderr: "",
			};
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};

	const store = createMemoryPreferenceStore(options.preference);

	return {
		calls,
		writes,
		warnings,
		files,
		deps: {
			isRealDevice: async () => options.real ?? true,
			systemctl,
			probeHelp: async (binary) => ({
				exitCode: 0,
				stdout: options.help ?? BLUEALSA_HELP,
				stderr: `probed ${binary}`,
			}),
			fileExists: async (p) => binaries.has(p) || files.has(p),
			readFile: async (p) => files.get(p),
			writeDropIn: async (_dir, p, contents) => {
				files.set(p, contents);
				writes.push({ path: p, contents });
			},
			preference: store,
			log: () => {},
			warn: (msg) => warnings.push(msg),
		},
	};
}

function verbs(calls: readonly string[][]): string[][] {
	return calls.filter((c) => c[0] === "enable" || c[0] === "disable");
}

beforeEach(() => {
	resetBluetoothServiceReconcileForTest();
});

describe("the BlueALSA unit name is pinned", () => {
	test("it is exactly `bluealsa.service`", () => {
		expect(BLUEALSA_UNIT).toBe("bluealsa.service");
	});

	test("`bluealsad` is the binary and is NEVER used as a unit name", () => {
		expect(BLUEALSA_UNIT).not.toBe("bluealsad.service");
		expect(BLUEALSA_UNIT).not.toBe("bluealsad");
		expect(BLUEALSA_UNIT.includes("bluealsad")).toBe(false);
		for (const unit of BLUETOOTH_UNITS) {
			expect(unit.endsWith(".service")).toBe(true);
			expect(unit.includes("bluealsad")).toBe(false);
		}
	});

	test("both governed units are the BlueZ daemon and BlueALSA, in that order", () => {
		expect([...BLUETOOTH_UNITS]).toEqual([
			"bluetooth.service",
			"bluealsa.service",
		]);
		expect(BLUETOOTH_UNIT).toBe("bluetooth.service");
	});

	test("the drop-in lives under the unit's own name, not the binary's", () => {
		expect(BLUEALSA_DROPIN_PATH).toContain("/bluealsa.service.d/");
		expect(BLUEALSA_DROPIN_PATH).not.toContain("bluealsad.service.d");
	});
});

describe("operator enable / disable is persistent-symmetric", () => {
	test("a PipeWire image governs bluetooth.service without probing or starting BlueALSA", async () => {
		const h = harness({
			binaries: [],
			enabledState: "disabled",
			activeState: "inactive",
		});
		h.files.set(PIPEWIRE_BLUETOOTH_PACKAGE_MARKER, "installed");

		const outcome = await setBluetoothEnabled(true, h.deps);

		expect(outcome.ok).toBe(true);
		expect(verbs(h.calls)).toEqual([["enable", "--now", "bluetooth.service"]]);
		expect(h.writes).toEqual([]);
		expect(h.calls.some((call) => call.includes("bluealsa.service"))).toBe(
			false,
		);
	});

	test("a PipeWire image disables bluetooth.service without touching BlueALSA", async () => {
		const h = harness({
			binaries: [],
			enabledState: "enabled",
			activeState: "active",
		});
		h.files.set(PIPEWIRE_BLUETOOTH_PACKAGE_MARKER, "installed");

		const outcome = await setBluetoothEnabled(false, h.deps);

		expect(outcome.ok).toBe(true);
		expect(verbs(h.calls)).toEqual([["disable", "--now", "bluetooth.service"]]);
		expect(h.calls.some((call) => call.includes("bluealsa.service"))).toBe(
			false,
		);
	});

	test("enable issues `enable --now` for BOTH units", async () => {
		const h = harness({ enabledState: "disabled", activeState: "inactive" });
		const outcome = await setBluetoothEnabled(true, h.deps);

		expect(outcome.ok).toBe(true);
		expect(verbs(h.calls)).toEqual([
			["enable", "--now", "bluetooth.service"],
			["enable", "--now", "bluealsa.service"],
		]);
	});

	test("disable issues `disable --now` — NEVER a bare stop", async () => {
		const h = harness({ enabledState: "enabled", activeState: "active" });
		await setBluetoothEnabled(false, h.deps);

		expect(verbs(h.calls)).toEqual([
			["disable", "--now", "bluetooth.service"],
			["disable", "--now", "bluealsa.service"],
		]);
		const bareStops = h.calls.filter(
			(c) => c[0] === "stop" || c[0] === "start",
		);
		expect(bareStops).toEqual([]);
	});

	test("the operator preference is persisted before the units are touched", async () => {
		const h = harness();
		await setBluetoothEnabled(true, h.deps);
		expect(h.deps.preference.read()).toEqual({ enabled: true });

		await setBluetoothEnabled(false, h.deps);
		expect(h.deps.preference.read()).toEqual({ enabled: false });
	});

	test("an already-settled unit is skipped (idempotent — zero mutations)", async () => {
		const h = harness({ enabledState: "enabled", activeState: "active" });
		const outcome = await setBluetoothEnabled(true, h.deps);

		expect(verbs(h.calls)).toEqual([]);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.units.every((u) => u.alreadyApplied)).toBe(true);
		}
	});

	test("a unit systemd does not know is REPORTED, never read as `disabled`", async () => {
		const h = harness();
		// systemd prints NOTHING on stdout for an unknown unit.
		h.deps.systemctl = async (args) => {
			h.calls.push([...args]);
			if (args[0] === "is-enabled") {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "Failed to get unit file state for bluealsad.service",
				};
			}
			return { exitCode: 0, stdout: "inactive\n", stderr: "" };
		};

		const outcome = await setBluetoothEnabled(true, h.deps);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.units.every((u) => u.detail === "unit_missing")).toBe(
				true,
			);
			expect(outcome.units.every((u) => u.applied)).toBe(false);
		}
		expect(verbs(h.calls)).toEqual([]);
		expect(h.warnings.some((w) => w.includes("systemd knows no unit"))).toBe(
			true,
		);
	});
});

describe("Bluetooth audio provider generation", () => {
	function detector(existing: readonly string[]) {
		const paths = new Set(existing);
		return detectBluetoothAudioProvider({
			fileExists: async (path) => paths.has(path),
		});
	}

	test("libspa with no BlueALSA marker selects PipeWire", async () => {
		await expect(detector([PIPEWIRE_BLUETOOTH_PACKAGE_MARKER])).resolves.toBe(
			"pipewire",
		);
	});

	test("a legacy package marker selects BlueALSA", async () => {
		await expect(detector([BLUEALSA_PACKAGE_MARKER])).resolves.toBe("bluealsa");
	});

	test("a mixed migration image keeps the legacy BlueALSA contract", async () => {
		await expect(
			detector([
				BLUEALSA_BINARIES[0] ?? "/usr/bin/bluealsad",
				PIPEWIRE_BLUETOOTH_PACKAGE_MARKER,
			]),
		).resolves.toBe("bluealsa");
	});

	test("an image carrying neither provider is unavailable", async () => {
		await expect(detector([])).resolves.toBe("unavailable");
	});
});

describe("the packaged unit keeps the privileged hardware posture", () => {
	test("ceralive.service runs as root without sandboxing directives", async () => {
		const unit = await Bun.file(
			new URL("../../../../deployment/ceralive.service", import.meta.url),
		).text();

		expect(unit).toContain("User=root");
		expect(unit).toContain("Group=root");
		for (const directive of [
			"CapabilityBoundingSet=",
			"NoNewPrivileges=",
			"ProtectSystem=",
			"PrivateDevices=",
		]) {
			expect(unit).not.toContain(directive);
		}
	});
});

describe("emulated hosts never touch the host", () => {
	test("a dev host is refused with the typed bt_unavailable and ZERO spawns", async () => {
		const h = harness({ real: false });
		const outcome = await setBluetoothEnabled(true, h.deps);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBe("bt_unavailable");
			expect(outcome.cause).toBe("emulated");
		}
		expect(h.calls).toEqual([]);
		expect(h.writes).toEqual([]);
		// The refusal precedes persistence too — nothing was recorded.
		expect(h.deps.preference.read()).toBeUndefined();
	});

	test("the boot reconciler is a no-op on a dev host", async () => {
		const h = harness({ real: false, preference: { enabled: true } });
		const outcome = await reconcileBluetoothServices(h.deps);

		expect(outcome.ok).toBe(false);
		expect(h.calls).toEqual([]);
	});
});

describe("the boot reconciler re-applies BOTH directions", () => {
	test("an operator who had Bluetooth ON gets the units enabled", async () => {
		const h = harness({
			enabledState: "disabled",
			activeState: "inactive",
			preference: { enabled: true },
		});
		const outcome = await reconcileBluetoothServices(h.deps);

		expect(outcome.ok).toBe(true);
		expect(verbs(h.calls)).toEqual([
			["enable", "--now", "bluetooth.service"],
			["enable", "--now", "bluealsa.service"],
		]);
	});

	test("an operator who had Bluetooth OFF gets the units disabled", async () => {
		const h = harness({
			enabledState: "enabled",
			activeState: "active",
			preference: { enabled: false },
		});
		await reconcileBluetoothServices(h.deps);

		expect(verbs(h.calls)).toEqual([
			["disable", "--now", "bluetooth.service"],
			["disable", "--now", "bluealsa.service"],
		]);
	});

	test("no persisted preference leaves the image's own unit state ALONE", async () => {
		const h = harness({ enabledState: "enabled", activeState: "active" });
		const outcome = await reconcileBluetoothServices(h.deps);

		expect(outcome.ok).toBe(true);
		expect(h.calls).toEqual([]);
	});

	test("a throwing systemctl is fail-soft (S6) — it returns, never throws", async () => {
		const h = harness({ preference: { enabled: true } });
		h.deps.systemctl = () => {
			throw new Error("dbus is down");
		};

		const outcome = await reconcileBluetoothServices(h.deps);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toBe("bt_unavailable");
	});
});

describe("the BlueALSA drop-in carries HFP-AG, and mSBC only when probed", () => {
	test("the reset line comes first, so systemd replaces rather than appends", () => {
		const body = buildBluealsaDropIn("/usr/bin/bluealsad", {
			msbc: false,
			codecFlag: true,
		});
		const lines = body.split("\n").filter((l) => l.startsWith("ExecStart"));
		expect(lines[0]).toBe("ExecStart=");
		expect(lines).toHaveLength(2);
	});

	test("HFP-AG is always requested", () => {
		const body = buildBluealsaDropIn("/usr/bin/bluealsad", {
			msbc: false,
			codecFlag: false,
		});
		expect(body).toContain("-p hfp-ag");
		expect(body).toContain("-p a2dp-source");
	});

	test("mSBC is PROBED — a wideband build gets `-c msbc`", async () => {
		const h = harness({ help: BLUEALSA_HELP });
		const outcome = await ensureBluealsaDropIn(h.deps);

		expect(outcome.msbc).toBe(true);
		expect(outcome.contents).toContain("-c msbc");
	});

	test("…and a narrowband build gets NO codec flag at all", async () => {
		const h = harness({ help: BLUEALSA_HELP_NARROWBAND });
		const outcome = await ensureBluealsaDropIn(h.deps);

		expect(outcome.msbc).toBe(false);
		expect(outcome.contents).not.toContain("msbc");
	});

	test("an unreadable help text warns and ships no codec flag", async () => {
		const h = harness({ help: "bluealsad: command not found" });
		const outcome = await ensureBluealsaDropIn(h.deps);

		expect(outcome.msbc).toBe(false);
		expect(outcome.contents).not.toContain("-c ");
		expect(h.warnings.some((w) => w.includes("--help"))).toBe(true);
	});

	test("an unchanged drop-in is not rewritten (no needless daemon-reload)", async () => {
		const h = harness();
		await ensureBluealsaDropIn(h.deps);
		expect(h.writes).toHaveLength(1);
		expect(h.calls.some((c) => c[0] === "daemon-reload")).toBe(true);

		h.calls.length = 0;
		const second = await ensureBluealsaDropIn(h.deps);
		expect(second.written).toBe(false);
		expect(h.writes).toHaveLength(1);
		expect(h.calls.some((c) => c[0] === "daemon-reload")).toBe(false);
	});

	test("no BlueALSA binary installed warns and writes nothing", async () => {
		const h = harness({ binaries: [] });
		const outcome = await ensureBluealsaDropIn(h.deps);

		expect(outcome.binary).toBeUndefined();
		expect(h.writes).toEqual([]);
		expect(h.warnings.some((w) => w.includes("no BlueALSA daemon"))).toBe(true);
	});

	test("the drop-in is written BEFORE the unit is started", async () => {
		const h = harness({ enabledState: "disabled", activeState: "inactive" });
		const order: string[] = [];
		const inner = h.deps.writeDropIn;
		h.deps.writeDropIn = async (dir, p, contents) => {
			order.push("write");
			await inner(dir, p, contents);
		};
		const innerCtl = h.deps.systemctl;
		h.deps.systemctl = async (args) => {
			if (args[0] === "enable") order.push(`enable:${String(args[2])}`);
			return innerCtl(args);
		};

		await setBluetoothEnabled(true, h.deps);
		expect(order[0]).toBe("write");
		expect(order).toContain("enable:bluealsa.service");
		expect(order.indexOf("write")).toBeLessThan(
			order.indexOf("enable:bluealsa.service"),
		);
	});
});

describe("named CLI parsers refuse malformed output (S2)", () => {
	test("is-enabled: EMPTY output is `empty-output`, never `disabled`", () => {
		const parsed = parseUnitEnabledState("");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.kind).toBe("empty-output");
	});

	test("is-enabled: an unknown word is typed, not coerced", () => {
		const parsed = parseUnitEnabledState("wibble\n");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.kind).toBe("unrecognized-state");
	});

	test("is-enabled: the real vocabulary parses", () => {
		for (const word of ["enabled", "disabled", "masked", "static"]) {
			const parsed = parseUnitEnabledState(`${word}\n`);
			expect(parsed.ok).toBe(true);
		}
		const enabled = parseUnitEnabledState("enabled\n");
		expect(enabled.ok && isPersistentlyEnabled(enabled.value)).toBe(true);
		const stat = parseUnitEnabledState("static\n");
		expect(stat.ok && isPersistentlyEnabled(stat.value)).toBe(false);
	});

	test("is-active: empty and unknown are both typed failures", () => {
		expect(parseUnitActiveState("").ok).toBe(false);
		expect(parseUnitActiveState("running\n").ok).toBe(false);
		expect(parseUnitActiveState("active\n").ok).toBe(true);
	});

	test("bluealsa help: a non-BlueALSA text is `unrecognized-help`", () => {
		const parsed = parseBluealsaHelp("bash: bluealsad: command not found");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.kind).toBe("unrecognized-help");
	});

	test("bluealsa help: empty output is `empty-output`", () => {
		const parsed = parseBluealsaHelp("   \n ");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.kind).toBe("empty-output");
	});
});
