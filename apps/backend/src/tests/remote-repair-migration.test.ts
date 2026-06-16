import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { getConfig } from "../modules/config.ts";
import {
	DEVICE_TOKEN_PUBLIC_KEY_ENV,
	mintStubDeviceToken,
} from "../modules/pairing/device-token.ts";
import {
	exportEd25519PublicKeyBase64,
	signV4Public,
} from "../modules/pairing/paseto-v4.ts";
import {
	forceRepairMigration,
	isPasetoVerificationActive,
	REMOTE_REPAIR_STATUS,
	resolveRemoteAuthDecision,
} from "../modules/remote/remote.ts";

// D3 forced re-pair migration (ADR-0006): once real PASETO verification goes
// live (PASETO_PUBLIC_KEY provisioned), a paired device whose stored credential
// is not a valid device token must be driven through a re-pair instead of
// presenting a credential the platform would silently reject (lockout).
//
// The PASETO gate is selected by the PRESENCE of PASETO_PUBLIC_KEY, mutated
// per-test, so snapshot and restore it to keep the gate from leaking into the
// other pairing suites in the same process (a stray key refuses every token).

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const SERIAL = "CERATESTSERIAL25";

let savedKey: string | undefined;
let platform: { publicKey: KeyObject; privateKey: KeyObject };
let platformPublicKeyB64: string;

beforeEach(() => {
	savedKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	platform = generateKeyPairSync("ed25519");
	platformPublicKeyB64 = exportEd25519PublicKeyBase64(platform.publicKey);
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	} else {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = savedKey;
	}
});

function relayClaims(overrides: Record<string, unknown> = {}) {
	return {
		device_id: SERIAL,
		sub_status: "ACTIVE",
		iat: NOW_SECONDS,
		exp: NOW_SECONDS + 3600,
		...overrides,
	};
}

/** A real platform-signed relay-config token (the freshly-paired happy path). */
function signRelayToken(overrides: Record<string, unknown> = {}): string {
	return signV4Public(
		JSON.stringify(relayClaims(overrides)),
		platform.privateKey,
	);
}

describe("D3 forced re-pair — resolveRemoteAuthDecision (ADR-0006)", () => {
	test("paired-but-tokenless device under live PASETO is routed to re-pair, not granted control", () => {
		// Real verification is live ...
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		// ... but the device still holds a legacy opaque operator key (no token).
		const decision = resolveRemoteAuthDecision("legacy-opaque-key", 16, NOW);

		expect(decision.action).toBe("force-repair");
		if (decision.action !== "force-repair") return;
		expect(decision.reason).toBe("tokenless-on-paseto-activation");
	});

	test("an expired-but-signed token under live PASETO is routed to re-pair (expiry forces re-pair)", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const expiredAt = NOW_SECONDS - 120;
		const token = signRelayToken({ iat: expiredAt - 3600, exp: expiredAt });

		expect(resolveRemoteAuthDecision(token, 16, NOW).action).toBe(
			"force-repair",
		);
	});

	test("a token signed by a DIFFERENT key under live PASETO is routed to re-pair (forgery)", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const attacker = generateKeyPairSync("ed25519");
		const forged = signV4Public(
			JSON.stringify(relayClaims()),
			attacker.privateKey,
		);

		expect(resolveRemoteAuthDecision(forged, 16, NOW).action).toBe(
			"force-repair",
		);
	});

	test("a freshly-paired device with a valid PASETO token is unaffected — control granted", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const token = signRelayToken();

		const decision = resolveRemoteAuthDecision(token, 16, NOW);

		expect(decision.action).toBe("present");
		if (decision.action !== "present") return;
		expect(decision.payload.key).toBe(token);
		expect(decision.payload.version).toBe(16);
		expect(decision.payload.sub_status).toBe("ACTIVE");
	});

	test("PASETO gated (no key) — a legacy opaque key is still presented (backward-compatible MVP path)", () => {
		const decision = resolveRemoteAuthDecision("legacy-opaque-key", 16, NOW);

		expect(decision.action).toBe("present");
		if (decision.action !== "present") return;
		expect(decision.payload.key).toBe("legacy-opaque-key");
		expect(decision.payload.sub_status).toBeUndefined();
	});

	test("PASETO gated (no key) — an unsigned stub token is presented with its standing", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});

		const decision = resolveRemoteAuthDecision(token, 16, NOW);

		expect(decision.action).toBe("present");
		if (decision.action !== "present") return;
		expect(decision.payload.sub_status).toBe("ACTIVE");
	});
});

describe("isPasetoVerificationActive — the D3 trigger gate", () => {
	test("false when no key is provisioned", () => {
		expect(isPasetoVerificationActive()).toBe(false);
	});

	test("true when a key is provisioned", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		expect(isPasetoVerificationActive()).toBe(true);
	});

	test("a blank/whitespace key is treated as unset (no hardcoded fallback)", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = "   ";
		expect(isPasetoVerificationActive()).toBe(false);
	});
});

describe("forceRepairMigration — drops a tokenless device to the unpaired floor", () => {
	// forceRepairMigration persists via the real saveConfig; snapshot+restore the
	// file bytes so the test never clobbers the dev config.json.
	let savedConfigBytes: string;

	beforeEach(async () => {
		savedConfigBytes = await Bun.file("config.json").text();
	});

	afterEach(async () => {
		await Bun.write("config.json", savedConfigBytes);
	});

	test("clears the dead credential + device_id so re-pairing is surfaced locally", () => {
		const config = getConfig();
		config.remote_key = "legacy-opaque-key";
		config.device_id = "7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e";

		forceRepairMigration("tokenless-on-paseto-activation");

		expect(getConfig().remote_key).toBeUndefined();
		expect(getConfig().device_id).toBeUndefined();
	});

	test("exposes a stable re-pair status code for clients", () => {
		expect(REMOTE_REPAIR_STATUS).toBe("repair");
	});
});
