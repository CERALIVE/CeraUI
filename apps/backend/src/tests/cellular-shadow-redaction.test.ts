/**
 * SIM-adjacent PII never reaches a shadow log line or a persisted shadow record.
 *
 * Every assertion here is a STRING SEARCH over serialized output — the raw bytes
 * of the JSONL file on disk, and the raw log lines the logger emitted. That is
 * deliberate: "the mapper only copies an allowlist" is a claim about a code path,
 * and a code path can be changed by someone who does not know why it was written
 * that way. Searching the artifact catches the leak whichever layer let it
 * through.
 *
 * The fixtures are REAL-SHAPED (19-digit ICCID, 32-digit EID, 15-digit IMSI/IMEI,
 * an APN with credentials) rather than the literal string "SECRET", because a
 * redactor keyed on shape must be given something with the right shape to miss.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import {
	resetModemShadow,
	startModemShadow,
	stopModemShadow,
} from "../modules/cellular/shadow.ts";
import {
	collectShadowStates,
	mmcliModemToShadowState,
	redactShadowDivergences,
	type ShadowStateSet,
} from "../modules/cellular/shadow-divergence.ts";
import { shadowEvidencePath } from "../modules/cellular/shadow-evidence.ts";
import { redactShadowPayload } from "../modules/cellular/shadow-redaction.ts";
import {
	observerRow,
	okList,
	recordingTransport,
	scriptedObserver,
} from "./helpers/shadow-harness.ts";

/** Real-shaped SIM-adjacent PII. None of these may survive into an artifact. */
const PII = {
	iccid: "8934071100003862105",
	eid: "89049032005008882600033891157296",
	imsi: "214075550001234",
	imei: "351756051523999",
	msisdn: "+34600111222",
	apn: "internet.movistar.example",
	apnUser: "carrier-user-42",
	apnPassword: "s3cr3t-apn-pass!",
	simPin: "4821",
	simPuk: "48213366",
} as const;

const PII_VALUES = Object.values(PII);

function expectNoPii(haystack: string, label: string): void {
	for (const [name, value] of Object.entries(PII)) {
		expect(`${label}:${name}:${haystack.includes(value)}`).toBe(
			`${label}:${name}:false`,
		);
	}
}

/** A modem record carrying every PII class the real one can carry. */
function leakyModem(ifname: string, over: Record<string, unknown> = {}) {
	return {
		ifname,
		name: `QUECTEL Broadband Module - ${PII.imei}`,
		sim_network: "Movistar",
		iccid: PII.iccid,
		eid: PII.eid,
		imsi: PII.imsi,
		imei: PII.imei,
		msisdn: PII.msisdn,
		status: { signal: 62, network: "Movistar", roaming: false },
		network_type: { active: "4G" },
		sim_lock: { required: "sim-pin" },
		config: {
			apn: PII.apn,
			username: PII.apnUser,
			password: PII.apnPassword,
			roaming: true,
			network: "",
		},
		simPin: PII.simPin,
		puk: PII.simPuk,
		...over,
	};
}

let tempDirs: string[] = [];

function tempEvidenceDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "ceralive-shadow-redact-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await stopModemShadow();
	resetModemShadow();
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("the redactor blanks every PII class, at any depth", () => {
	for (const [name, key] of [
		["ICCID", "iccid"],
		["EID", "eid"],
		["IMSI", "imsi"],
		["IMEI", "imei"],
		["MSISDN", "msisdn"],
		["APN", "apn"],
		["APN username", "username"],
		["APN password", "password"],
		["SIM PIN", "pin"],
		["SIM PUK", "puk"],
	] as const) {
		test(`${name} is blanked at the top level`, () => {
			const out = JSON.stringify(
				redactShadowPayload({ [key]: PII_VALUES.join("|") }),
			);
			expectNoPii(out, name);
		});
	}

	test("a dotted NetworkManager key is blanked on its last segment", () => {
		const out = JSON.stringify(
			redactShadowPayload({
				"gsm.apn": PII.apn,
				"gsm.username": PII.apnUser,
				"gsm.password": PII.apnPassword,
			}),
		);
		expectNoPii(out, "dotted");
	});

	test("PII nested inside objects and arrays is blanked too", () => {
		const out = JSON.stringify(
			redactShadowPayload({
				modems: [
					{
						slots: [{ iccid: PII.iccid, eid: PII.eid }],
						policy: { connection: { auth: { password: PII.apnPassword } } },
					},
				],
				identity: { subscriptionId: PII.iccid, equipmentId: PII.imei },
			}),
		);
		expectNoPii(out, "nested");
	});

	test("a non-sensitive sibling survives, so redaction is not a blanket wipe", () => {
		const out = redactShadowPayload({
			operatorName: "Movistar",
			networkType: "4G",
			signalBucket: "good",
			slotIndex: 1,
			iccid: PII.iccid,
		}) as Record<string, unknown>;
		expect(out.operatorName).toBe("Movistar");
		expect(out.networkType).toBe("4G");
		expect(out.signalBucket).toBe("good");
		expect(out.slotIndex).toBe(1);
		expect(out.iccid).not.toBe(PII.iccid);
	});

	test("the composition errs toward OVER-redaction, never under", () => {
		// `gsm.password-flags` is a "0"/"4" flag, not a secret. The package's exact
		// key rule spares it; CeraUI's substring regex does not. The union keeping
		// it redacted is the safe direction of that disagreement, and asserting it
		// stops a future "fix" from loosening the union to match the narrower rule.
		const out = redactShadowPayload({ "gsm.password-flags": "0" }) as Record<
			string,
			unknown
		>;
		expect(out["gsm.password-flags"]).toBe("[REDACTED]");
	});

	test("the input is never mutated", () => {
		const input = { iccid: PII.iccid };
		redactShadowPayload(input);
		expect(input.iccid).toBe(PII.iccid);
	});
});

describe("the divergence log payload carries no PII", () => {
	test("a leaky modem's mapped state produces a clean redacted payload", () => {
		const mapped = collectShadowStates(
			[leakyModem("wwan0")],
			mmcliModemToShadowState,
		);
		const payload = JSON.stringify(
			redactShadowDivergences([
				{ deviceKey: mapped.states[0]?.deviceKey ?? "", kind: "only-in-mmcli" },
			]),
		);
		expectNoPii(payload, "divergence-payload");
	});

	test("the REAL logger's emitted lines carry no PII across a shadow session", async () => {
		clearRecentLogLines();
		const transport = recordingTransport();
		const build = scriptedObserver(okList([observerRow("wwan9")]));
		const dir = tempEvidenceDir();

		await startModemShadow({
			createTransport: () => transport,
			createObserver: build,
			readMmcliStates: (): ShadowStateSet =>
				collectShadowStates([leakyModem("wwan0")], mmcliModemToShadowState),
			evidence: { baseDir: dir },
			schedule: () => () => undefined,
		});

		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("modem shadow divergence");
		expectNoPii(emitted, "logger");
	});
});

describe("the persisted JSONL on disk carries no PII", () => {
	test("a full session's raw evidence bytes contain none of the fixtures", async () => {
		const dir = tempEvidenceDir();
		const transport = recordingTransport();
		let observer: ReturnType<ReturnType<typeof scriptedObserver>> | undefined;
		const build = scriptedObserver(okList([observerRow("wwan1")]));
		let heartbeat = (): void => undefined;

		await startModemShadow({
			createTransport: () => transport,
			createObserver: (audited) => {
				observer = build(audited);
				return observer;
			},
			readMmcliStates: (): ShadowStateSet =>
				collectShadowStates(
					[leakyModem("wwan0"), leakyModem("wwan1")],
					mmcliModemToShadowState,
				),
			log: () => undefined,
			evidence: { baseDir: dir },
			schedule: (fn) => {
				heartbeat = fn;
				return () => undefined;
			},
		});

		observer?.emit(okList([observerRow("wwan1", { presence: "absent" })]));
		heartbeat();
		await stopModemShadow();

		const raw = readFileSync(shadowEvidencePath(dir), "utf8");
		expect(raw.length).toBeGreaterThan(0);
		expect(raw).toContain('"kind":"heartbeat"');
		expect(raw).toContain('"kind":"divergence"');
		expectNoPii(raw, "jsonl");
	});

	test("PII that somehow reached the append seam is still blanked before the write", async () => {
		const dir = tempEvidenceDir();
		const { appendShadowEvidence } = await import(
			"../modules/cellular/shadow-evidence.ts"
		);
		appendShadowEvidence(
			{
				kind: "divergence",
				deviceKey: "d-0123456789abcdef",
				divergence: "field-mismatch",
				fields: {
					iccid: { mmcli: PII.iccid, dbus: PII.eid },
					apn: { mmcli: PII.apn, dbus: PII.apnUser },
					password: { mmcli: PII.apnPassword, dbus: PII.simPuk },
					imsi: { mmcli: PII.imsi, dbus: PII.imei },
					msisdn: { mmcli: PII.msisdn, dbus: PII.msisdn },
					pin: { mmcli: PII.simPin, dbus: PII.simPin },
				},
			},
			{ baseDir: dir },
		);
		const raw = readFileSync(shadowEvidencePath(dir), "utf8");
		expectNoPii(raw, "append-seam");
	});

	test("the persisted record is keyed by an OPAQUE id, never by the ifname", async () => {
		const dir = tempEvidenceDir();
		const transport = recordingTransport();
		const build = scriptedObserver(okList([]));

		await startModemShadow({
			createTransport: () => transport,
			createObserver: build,
			readMmcliStates: (): ShadowStateSet =>
				collectShadowStates([leakyModem("wwan0")], mmcliModemToShadowState),
			log: () => undefined,
			evidence: { baseDir: dir },
			schedule: () => () => undefined,
		});
		await stopModemShadow();

		const raw = readFileSync(shadowEvidencePath(dir), "utf8");
		expect(raw).toContain('"deviceKey":"d-');
		expect(raw).not.toContain("wwan0");
	});
});
