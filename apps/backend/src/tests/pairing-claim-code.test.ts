import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import {
	CLAIM_CODE_ALPHABET,
	CLAIM_CODE_RE,
	claimCodeOutputSchema,
} from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import {
	CLAIM_CODE_LENGTH,
	CLAIM_CODE_WINDOW_SECONDS,
	deriveClaimCode,
	generateClaimCode,
	getPairingSecret,
	issueDeviceToken,
} from "../modules/pairing/claim-code.ts";
import { generateClaimCodeProcedure } from "../rpc/procedures/pairing.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Fixed seed material so derivation is fully deterministic in these tests.
const SERIAL = "CERATESTSERIAL01";
const SECRET = "dGVzdC1zZWNyZXQtZm9yLWNsYWltLWNvZGUtZGVyaXZhdGlvbg==";

const WINDOW_MS = CLAIM_CODE_WINDOW_SECONDS * 1000;
// A concrete epoch instant that sits 1s into a window boundary.
const WINDOW_START = 1_700_000_000_000 - (1_700_000_000_000 % WINDOW_MS);
const NOW = WINDOW_START + 1_000;

function makeContext(authed = true): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: authed, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => authed,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

describe("claim-code derivation — charset, length, validity window", () => {
	test("code matches the unambiguous charset and 6–8 length bound", () => {
		const { code } = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		expect(code).toMatch(CLAIM_CODE_RE);
		expect(code).toHaveLength(CLAIM_CODE_LENGTH);
		for (const ch of code) {
			expect(CLAIM_CODE_ALPHABET).toContain(ch);
		}
	});

	test("charset excludes visually ambiguous characters 0/O/1/I/L", () => {
		for (const ch of ["0", "O", "1", "I", "L"]) {
			expect(CLAIM_CODE_ALPHABET.includes(ch)).toBe(false);
		}
		// And no generated code can contain them.
		const { code } = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		expect(code).not.toMatch(/[0O1IL]/);
	});

	test("validUntil is the window end and windowSeconds is the configured window", () => {
		const result = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		expect(result.windowSeconds).toBe(CLAIM_CODE_WINDOW_SECONDS);
		expect(result.validUntil).toBe(WINDOW_START + WINDOW_MS);
		// The code is valid from now until validUntil, and the window is exactly
		// windowSeconds long (no longer).
		expect(result.validUntil).toBeGreaterThan(NOW);
		expect(result.validUntil % WINDOW_MS).toBe(0);
		expect(result.validUntil - WINDOW_START).toBe(WINDOW_MS);
	});

	test("output validates against the shared claimCodeOutputSchema", () => {
		const result = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		expect(() => claimCodeOutputSchema.parse(result)).not.toThrow();
	});
});

describe("claim-code stability and rotation", () => {
	test("code is stable for every instant within the same window", () => {
		const base = deriveClaimCode({ now: WINDOW_START, serial: SERIAL, secret: SECRET });
		for (const offset of [0, 1, 1_000, WINDOW_MS / 2, WINDOW_MS - 1]) {
			const again = deriveClaimCode({
				now: WINDOW_START + offset,
				serial: SERIAL,
				secret: SECRET,
			});
			expect(again.code).toBe(base.code);
			expect(again.validUntil).toBe(base.validUntil);
		}
	});

	test("code rotates once the window elapses", () => {
		const current = deriveClaimCode({ now: WINDOW_START, serial: SERIAL, secret: SECRET });
		const next = deriveClaimCode({
			now: WINDOW_START + WINDOW_MS,
			serial: SERIAL,
			secret: SECRET,
		});
		expect(next.code).not.toBe(current.code);
		expect(next.validUntil).toBe(current.validUntil + WINDOW_MS);
	});

	test("code is namespaced to the device serial", () => {
		const a = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		const b = deriveClaimCode({ now: NOW, serial: "DIFFERENT-SERIAL", secret: SECRET });
		expect(a.code).not.toBe(b.code);
	});

	test("code depends on the secret seed (different secret → different code)", () => {
		const a = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET });
		const b = deriveClaimCode({ now: NOW, serial: SERIAL, secret: "another-secret-key==" });
		expect(a.code).not.toBe(b.code);
	});
});

describe("pairing secret — crypto-seeded, persistent", () => {
	test("mints and persists a crypto-random secret when none exists", () => {
		const config = getConfig();
		config.pairing_secret = undefined;

		const secret = getPairingSecret();
		expect(typeof secret).toBe("string");
		expect(secret.length).toBeGreaterThan(0);
		// Persisted onto the runtime config so it survives a restart.
		expect(getConfig().pairing_secret).toBe(secret);
		// Stable across subsequent reads (does not rotate per-call).
		expect(getPairingSecret()).toBe(secret);
	});
});

describe("generateClaimCode + pairing.generateClaimCode RPC", () => {
	beforeAll(() => {
		process.env.DEVICE_SERIAL = SERIAL;
	});
	afterAll(() => {
		delete process.env.DEVICE_SERIAL;
	});

	test("generateClaimCode is stable within a window for the live device", async () => {
		const a = await generateClaimCode(NOW);
		const b = await generateClaimCode(NOW + 5_000);
		expect(a.code).toBe(b.code);
		expect(a.validUntil).toBe(b.validUntil);
		expect(() => claimCodeOutputSchema.parse(a)).not.toThrow();
	});

	test("RPC returns a schema-valid, time-bounded code for an authed caller", async () => {
		const result = await call(generateClaimCodeProcedure, undefined, {
			context: makeContext(true),
		});
		expect(result.code).toMatch(CLAIM_CODE_RE);
		expect(result.windowSeconds).toBe(CLAIM_CODE_WINDOW_SECONDS);
		expect(result.validUntil).toBeGreaterThan(Date.now());
		expect(() => claimCodeOutputSchema.parse(result)).not.toThrow();
	});

	test("RPC rejects an unauthenticated caller", async () => {
		const promise = call(generateClaimCodeProcedure, undefined, {
			context: makeContext(false),
		});
		await expect(promise).rejects.toThrow();
	});
});

describe("device token issuance is deferred (ADR-0006 proposed)", () => {
	test("issueDeviceToken is a stub that mints no token", () => {
		// ADR-0006 (PASETO v4.public) is still `proposed`; claim-code generation
		// must NOT mint or verify any token until it is accepted (Task 25).
		expect(issueDeviceToken()).toBeNull();
	});
});
