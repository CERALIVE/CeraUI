/*
 * The five-state device lock model, and the three procedures that move it.
 *
 * Every assertion here is a SAFETY or HONESTY property rather than a feature.
 * Each of them degrades silently if it breaks — a lock state that latches, a
 * verify that retries into a lockout, a password that reaches a log — so each
 * gets its own test and, where absence is the claim, its own non-vacuity
 * control.
 */

import { afterEach, describe, expect, it } from "bun:test";

import type {
	ModemCredentialsOutput,
	ModemLockState,
	RouterAdmin,
} from "@ceraui/rpc/schemas";
import {
	MODEM_LOCK_STATES,
	modemCredentialsOutputSchema,
} from "@ceraui/rpc/schemas";

import {
	type CredentialTarget,
	type CredentialTransport,
	classifyHilinkLoginResponse,
	hilinkLoginDocument,
	type RouterLoginPort,
	verifyModemCredential,
} from "../modules/modems/modem-credential-verify.ts";
import type { ModemCredential } from "../modules/modems/modem-credentials.ts";
import {
	classifyAuthAttempt,
	classifyHilinkLoginState,
	gateRouterAdminByLock,
	noteLockOpenEvidence,
	noteLockOutcome,
	readLockOpenEvidence,
	resetModemLockSessionsForTest,
	resolveModemLock,
} from "../modules/modems/modem-lock-state.ts";
import { fromRouterCellularView } from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import {
	type PhysicalObservation,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";
import {
	defaultRpcLoggingDeps,
	isSensitiveProcedure,
	logRpcCall,
	type RpcCallTrace,
} from "../rpc/rpc-logging.ts";

/** A password that could never occur by accident in a payload or a log line. */
const PASSWORD = "z9Qv-lock-secret-8813";
const USERNAME = "admin";

const BENCH_HILINK: PhysicalObservation = {
	ifname: "enx0c5b8f279a64",
	idPath: "platform-xhci-hcd.0.auto-usb-0:1.3.1",
	vid: "12d1",
	pid: "14dc",
};

/**
 * The full admin reading, with BOTH operation blocks present. `capabilities` and
 * `controls` are the two things the lock gate withholds; everything else is an
 * observation and must survive the gate untouched.
 */
const FULL_ADMIN: RouterAdmin = {
	admin_url: "http://192.168.8.1",
	reachable: true,
	model: "E3372",
	sim: "present",
	capabilities: {
		net_mode: {
			state: "reported",
			modes: [{ id: "00", label: "AUTO" }],
		},
	},
	controls: { mobile_data: true },
};

function deviceRecord() {
	resetPhysicalIdentityRegistry();
	return resolvePhysicalDevice(BENCH_HILINK);
}

function targetFor(): CredentialTarget {
	return {
		ifname: BENCH_HILINK.ifname,
		adminUrl: FULL_ADMIN.admin_url,
		dialect: "hilink",
		device: deviceRecord(),
	};
}

function lockFor(
	identityKey: string,
	configured: boolean,
): { state: ModemLockState; detail: { credential_configured: boolean } } {
	return resolveModemLock({
		identityKey,
		openEvidence: readLockOpenEvidence(BENCH_HILINK.ifname),
		credential: { configured },
	});
}

/** Build the wire entry through the SHIPPED projector and the SHIPPED gate. */
function wireEntryFor(state: ModemLockState, configured: boolean) {
	const device = deviceRecord();
	const source = fromRouterCellularView({
		ifname: BENCH_HILINK.ifname,
		vendor: "Huawei",
		model: "E3372",
		vidPid: "12d1:14dc",
		hasAddress: true,
		identity: device,
		admin: gateRouterAdminByLock(FULL_ADMIN, state),
	});
	const { message } = projectModemWire([source], {
		hasGsmAutoconfig: false,
		lockFor: () => ({
			state,
			detail: { credential_configured: configured },
		}),
	});
	const [entry] = Object.values(message);
	if (entry === undefined) throw new Error("no wire entry projected");
	return entry;
}

afterEach(() => {
	resetModemLockSessionsForTest();
	resetPhysicalIdentityRegistry();
});

describe("all five lock states are reachable and EXPLICIT on the wire", () => {
	it("carries every state as a stated value, `open` included", () => {
		for (const state of MODEM_LOCK_STATES) {
			const entry = wireEntryFor(state, state !== "open");

			expect(entry.lock_state).toBe(state);
			expect(JSON.stringify(entry)).toContain(`"lock_state":"${state}"`);
		}
	});

	it("never encodes a state as the ABSENCE of the field", () => {
		// The latch this rules out: the frontend modem merge preserves an omitted
		// optional field, so a row that went `locked` → `open` could never lower
		// the claim if `open` were spelled as "no lock_state".
		const open = JSON.stringify(wireEntryFor("open", false));

		expect(open).toContain('"lock_state"');
		expect(open).toContain('"credential_configured":false');
	});

	it("states `credential_configured` in BOTH directions", () => {
		expect(
			wireEntryFor("locked", true).lock_detail?.credential_configured,
		).toBe(true);
		expect(
			wireEntryFor("locked", false).lock_detail?.credential_configured,
		).toBe(false);
	});

	it("emits NEITHER key for a device with no admin surface", () => {
		const source = fromRouterCellularView({
			ifname: "eth1",
			vendor: "Huawei",
			model: "E3372",
			vidPid: "12d1:14dc",
			hasAddress: true,
		});
		const { message } = projectModemWire([source], { hasGsmAutoconfig: false });
		const [entry] = Object.values(message);

		expect(entry?.lock_state).toBeUndefined();
		expect(entry?.lock_detail).toBeUndefined();
	});
});

describe("the resolution ladder", () => {
	it("detects `open` from HiLink's own login-state document", () => {
		expect(
			classifyHilinkLoginState("<response><State>0</State></response>"),
		).toBe("open");
		expect(
			classifyHilinkLoginState("<response><State>-1</State></response>"),
		).toBe("locked");
	});

	it("resolves `locked` for a dialect that cannot tell, never `open`", () => {
		expect(
			classifyHilinkLoginState("<response><foo/></response>"),
		).toBeUndefined();

		const device = deviceRecord();
		expect(lockFor(device.identityKey, false).state).toBe("locked");
	});

	it("reports `open` only on positive evidence", () => {
		const device = deviceRecord();
		noteLockOpenEvidence(BENCH_HILINK.ifname, "open");

		expect(lockFor(device.identityKey, false).state).toBe("open");
	});

	it("WITHDRAWS an open claim the read can no longer support", () => {
		const device = deviceRecord();
		noteLockOpenEvidence(BENCH_HILINK.ifname, "open");
		noteLockOpenEvidence(BENCH_HILINK.ifname, undefined);

		expect(lockFor(device.identityKey, false).state).toBe("locked");
	});

	it("maps the stack's four refusal details honestly", () => {
		expect(classifyAuthAttempt("auth-accepted").state).toBe("unlocked");
		expect(classifyAuthAttempt("auth-rejection").state).toBe("auth-failed");
		expect(classifyAuthAttempt("lockout").state).toBe("locked-out");
	});

	it("keeps `protocol-mismatch` OUT of `auth-failed`", () => {
		const mismatch = classifyAuthAttempt("protocol-mismatch");

		expect(mismatch.state).toBe("locked");
		expect(mismatch.state).not.toBe("auth-failed");
		expect(mismatch.subReason).toBe("unsupported-profile");
	});
});

describe("capability expansion", () => {
	it("WITHHOLDS the operation blocks while the device is not unlocked", () => {
		for (const state of ["locked", "auth-failed", "locked-out"] as const) {
			const entry = wireEntryFor(state, true);

			expect(entry.router_admin?.capabilities).toBeUndefined();
			expect(entry.router_admin?.controls).toBeUndefined();
		}
	});

	it("keeps every OBSERVATION on a withheld row", () => {
		const entry = wireEntryFor("locked", true);

		expect(entry.router_admin?.admin_url).toBe(FULL_ADMIN.admin_url);
		expect(entry.router_admin?.reachable).toBe(true);
		expect(entry.router_admin?.sim).toBe("present");
	});

	it("OFFERS a previously-withheld operation once the device is unlocked", () => {
		expect(
			wireEntryFor("locked", true).router_admin?.capabilities,
		).toBeUndefined();

		const unlocked = wireEntryFor("unlocked", true);

		expect(unlocked.router_admin?.capabilities?.net_mode.state).toBe(
			"reported",
		);
		expect(unlocked.router_admin?.controls?.mobile_data).toBe(true);
	});

	it("offers them on an `open` device with no credential at all", () => {
		expect(wireEntryFor("open", false).router_admin?.controls).toBeDefined();
	});
});

interface Recorder {
	readonly requests: string[];
	readonly attempts: number[];
	readonly port: RouterLoginPort;
	readonly transport: CredentialTransport;
}

function recorder(
	detectOpen: "open" | "locked" | undefined,
	detail: Parameters<typeof classifyAuthAttempt>[0],
	rejectAt?: "detect" | "attempt",
): Recorder {
	const requests: string[] = [];
	const attempts: number[] = [];
	return {
		requests,
		attempts,
		port: {
			detectOpen: async () => {
				requests.push("detect");
				if (rejectAt === "detect") throw new Error("transport down");
				return detectOpen;
			},
			attempt: async () => {
				requests.push("attempt");
				attempts.push(1);
				if (rejectAt === "attempt") throw new Error("transport down");
				return detail;
			},
		},
		transport: {
			fetchViaInterface: async () => {
				requests.push("fetch");
				return [];
			},
			postViaInterface: async () => {
				requests.push("post");
				return "";
			},
		},
	};
}

function verifyDeps(
	rec: Recorder,
	target: CredentialTarget,
	credential: ModemCredential | null = {
		username: USERNAME,
		password: PASSWORD,
	},
) {
	return {
		isRealDevice: async () => true,
		resolveTarget: () => target,
		readCredential: () => credential ?? undefined,
		loginPort: rec.port,
		transport: rec.transport,
		now: () => 1_700_000_000_000,
	};
}

describe("verifying a stored credential", () => {
	it("returns `unreachable` and withdraws stale open evidence when detection rejects", async () => {
		const target = targetFor();
		noteLockOpenEvidence(target.ifname, "open");
		const rec = recorder("locked", "auth-accepted", "detect");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome).toEqual({
			success: false,
			error: "unreachable",
			target,
		});
		expect(readLockOpenEvidence(target.ifname)).toBeUndefined();
		expect(rec.requests).toEqual(["detect"]);
		expect(rec.attempts).toEqual([]);
	});

	it("returns `unreachable` without recording auth failure or retrying when login rejects", async () => {
		const target = targetFor();
		const rec = recorder("locked", "auth-accepted", "attempt");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome).toEqual({
			success: false,
			error: "unreachable",
			target,
		});
		expect(rec.requests).toEqual(["detect", "attempt"]);
		expect(rec.attempts).toHaveLength(1);
		expect(lockFor(target.device.identityKey, true).state).toBe("locked");
	});

	it("refuses a locked-out device with ZERO device requests", async () => {
		const target = targetFor();
		noteLockOutcome(target.device.identityKey, { state: "locked-out" });
		const rec = recorder("locked", "auth-accepted");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome.error).toBe("locked_out");
		expect(rec.requests).toEqual([]);
	});

	it("does NOT auto-retry after the device rejects the credential", async () => {
		const target = targetFor();
		const rec = recorder("locked", "auth-rejection");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome.success).toBe(false);
		expect(outcome.error).toBe("auth_failed");
		expect(rec.attempts).toHaveLength(1);
		expect(lockFor(target.device.identityKey, true).state).toBe("auth-failed");
	});

	it("unlocks on acceptance, and the row expands with it", async () => {
		const target = targetFor();
		const rec = recorder("locked", "auth-accepted");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome.success).toBe(true);
		expect(lockFor(target.device.identityKey, true).state).toBe("unlocked");
	});

	it("refuses to present a credential to an OPEN device", async () => {
		const target = targetFor();
		const rec = recorder("open", "auth-accepted");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome.error).toBe("device_open");
		expect(rec.attempts).toEqual([]);
	});

	it("reports an unsupported dialect as `unsupported_profile`", async () => {
		const target = targetFor();
		const rec = recorder("locked", "protocol-mismatch");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);

		expect(outcome.error).toBe("unsupported_profile");
		expect(outcome.error).not.toBe("auth_failed");
	});

	it("answers `no_credential` rather than attempting an empty login", async () => {
		const target = targetFor();
		const rec = recorder("locked", "auth-accepted");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target, null),
		);

		expect(outcome.error).toBe("no_credential");
		expect(rec.attempts).toEqual([]);
	});
});

describe("no procedure output carries a password", () => {
	it("strips a secret smuggled into the answer shape", () => {
		const parsed: ModemCredentialsOutput = modemCredentialsOutputSchema.parse({
			success: true,
			lock_state: "unlocked",
			lock_detail: { credential_configured: true },
			password: PASSWORD,
			username: USERNAME,
		});

		const serialized = JSON.stringify(parsed);
		expect(serialized).not.toContain(PASSWORD);
		expect(serialized).not.toContain(USERNAME);
	});

	it("carries no secret through a real verify outcome", async () => {
		const target = targetFor();
		const rec = recorder("locked", "auth-accepted");

		const outcome = await verifyModemCredential(
			"1000",
			verifyDeps(rec, target),
		);
		const answer = modemCredentialsOutputSchema.parse({
			success: outcome.success,
			lock_state: lockFor(target.device.identityKey, true).state,
			lock_detail: { credential_configured: true },
		});

		expect(JSON.stringify(answer)).not.toContain(PASSWORD);
	});

	it("keeps the derived HiLink password out of the DOCUMENT's plaintext", () => {
		const document = hilinkLoginDocument(4, USERNAME, PASSWORD, "tok-1");

		expect(document).not.toContain(PASSWORD);
		expect(document).toContain("<password_type>4</password_type>");
	});

	it("classifies Huawei's own login codes without inventing a rejection", () => {
		expect(classifyHilinkLoginResponse("<response>OK</response>")).toBe(
			"auth-accepted",
		);
		expect(
			classifyHilinkLoginResponse("<error><code>108006</code></error>"),
		).toBe("auth-rejection");
		expect(
			classifyHilinkLoginResponse("<error><code>108007</code></error>"),
		).toBe("lockout");
		expect(
			classifyHilinkLoginResponse("<error><code>999999</code></error>"),
		).toBe("protocol-mismatch");
	});
});

describe("rpc-logging omits the credential procedures' args", () => {
	const traceFor = (path: readonly string[]): RpcCallTrace => ({
		path,
		input: { device: "1000", username: USERNAME, password: PASSWORD },
		ok: true,
		latencyMs: 1,
		cid: "deadbeef",
	});

	function capture(path: readonly string[]): Record<string, unknown> {
		let captured: Record<string, unknown> = {};
		logRpcCall(traceFor(path), {
			...defaultRpcLoggingDeps,
			isEnabled: () => true,
			sink: {
				debug: (_message, meta) => {
					captured = meta ?? {};
				},
			},
		});
		return captured;
	}

	it("treats all three as credential-bearing", () => {
		for (const name of [
			"setCredentials",
			"clearCredentials",
			"verifyCredentials",
		]) {
			expect(isSensitiveProcedure(["modems", name])).toBe(true);
			expect(capture(["modems", name]).args).toBeUndefined();
		}
	});

	it("leaves the rest of the `modems` namespace diagnosable", () => {
		expect(isSensitiveProcedure(["modems", "getAll"])).toBe(false);
		expect(capture(["modems", "getAll"]).args).toBeDefined();
	});

	it("still omits the whole `auth.*` namespace", () => {
		expect(isSensitiveProcedure(["auth", "login"])).toBe(true);
		expect(capture(["auth", "login"]).args).toBeUndefined();
	});
});

describe("the shipped composition is wired, not only the pure halves", () => {
	const producer = Bun.file(
		new URL("../modules/modems/modem-wire-producer.ts", import.meta.url)
			.pathname,
	);

	it("gates the router admin block on the resolved lock", async () => {
		const source = await producer.text();

		expect(source).toContain("gateRouterAdminByLock(");
		expect(source).toContain("lockFor: projectModemLock");
	});

	it("reads the login-state document on the admin cycle", async () => {
		const admin = await Bun.file(
			new URL("../modules/network/router-cellular-admin.ts", import.meta.url)
				.pathname,
		).text();

		expect(admin).toContain("HILINK_USER_STATE_PATH");
		expect(admin).toContain("noteLockOpenEvidence(");
	});
});
