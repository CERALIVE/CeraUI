import { describe, expect, test } from "bun:test";

import {
	CLAIM_CODE_SKEW_SECONDS,
	CLAIM_CODE_WINDOW_SECONDS,
	deriveClaimCode,
	verifyClaimCode,
} from "../modules/pairing/claim-code.ts";

// Fixed seed material — derivation/verification is fully deterministic here.
const SERIAL = "CERATESTSERIAL01";
const SECRET = "dGVzdC1zZWNyZXQtZm9yLWNsYWltLWNvZGUtc2tldw==";

const WINDOW_S = CLAIM_CODE_WINDOW_SECONDS; // 300
const SKEW_S = CLAIM_CODE_SKEW_SECONDS; // 30
const WINDOW_MS = WINDOW_S * 1000;
const SKEW_MS = SKEW_S * 1000;

// Pick a window N and its trailing boundary. `boundary` is simultaneously the
// exclusive end of window N and the start of window N+1.
const N = 5_000_000;
const START = N * WINDOW_MS;
const BOUNDARY = (N + 1) * WINDOW_MS;

// The code shown during window N, and the code that takes over in window N+1.
const codeN = deriveClaimCode({
	now: START + 1_000,
	serial: SERIAL,
	secret: SECRET,
	windowSeconds: WINDOW_S,
}).code;
const codeNext = deriveClaimCode({
	now: BOUNDARY + 1_000,
	serial: SERIAL,
	secret: SECRET,
	windowSeconds: WINDOW_S,
}).code;

function verify(code: string, now: number): boolean {
	return verifyClaimCode({
		code,
		now,
		serial: SERIAL,
		secret: SECRET,
		windowSeconds: WINDOW_S,
		skewSeconds: SKEW_S,
	});
}

describe("claim-code skew tolerance — preconditions", () => {
	test("adjacent windows produce distinct codes", () => {
		expect(codeN).not.toBe(codeNext);
	});
});

describe("claim-code verifies anywhere inside its own window", () => {
	test("current code accepted across the full window span", () => {
		for (const now of [START, START + 1_000, START + WINDOW_MS / 2, BOUNDARY - 1]) {
			expect(verify(codeN, now)).toBe(true);
		}
	});
});

describe("forward skew — old code survives ±30s past the boundary", () => {
	test("old code still accepted within +30s after the boundary", () => {
		expect(verify(codeN, BOUNDARY)).toBe(true);
		expect(verify(codeN, BOUNDARY + SKEW_MS - 1)).toBe(true);
	});

	test("new code is already accepted in the skew band after the boundary", () => {
		expect(verify(codeNext, BOUNDARY)).toBe(true);
		expect(verify(codeNext, BOUNDARY + SKEW_MS - 1)).toBe(true);
	});

	test("old code is rejected once it is more than 30s past the boundary", () => {
		expect(verify(codeN, BOUNDARY + SKEW_MS)).toBe(false);
		expect(verify(codeN, BOUNDARY + SKEW_MS + 1)).toBe(false);
	});
});

describe("backward skew — new code accepted up to 30s before the boundary", () => {
	test("new code accepted within the 30s lead-in before the boundary", () => {
		expect(verify(codeNext, BOUNDARY - SKEW_MS)).toBe(true);
		expect(verify(codeNext, BOUNDARY - SKEW_MS + 1)).toBe(true);
	});

	test("old code is still accepted in that same lead-in band", () => {
		expect(verify(codeN, BOUNDARY - SKEW_MS)).toBe(true);
	});

	test("new code is rejected earlier than 30s before the boundary", () => {
		expect(verify(codeNext, BOUNDARY - SKEW_MS - 1)).toBe(false);
	});
});

describe("skew band rejects unrelated and wrong-window codes", () => {
	test("a code two windows away never verifies inside the band", () => {
		const farCode = deriveClaimCode({
			now: START - WINDOW_MS - 1_000, // window N-2 region
			serial: SERIAL,
			secret: SECRET,
			windowSeconds: WINDOW_S,
		}).code;
		// Far code is only valid in its own (distant) window, not near BOUNDARY.
		if (farCode !== codeN && farCode !== codeNext) {
			expect(verify(farCode, BOUNDARY)).toBe(false);
		}
	});

	test("a code from a different device serial does not verify", () => {
		const otherSerialCode = deriveClaimCode({
			now: START + 1_000,
			serial: "SOME-OTHER-DEVICE",
			secret: SECRET,
			windowSeconds: WINDOW_S,
		}).code;
		if (otherSerialCode !== codeN) {
			expect(verify(otherSerialCode, START + 1_000)).toBe(false);
		}
	});

	test("garbage input never verifies", () => {
		expect(verify("ZZZZZZZZ", START + 1_000)).toBe(false);
		expect(verify("", START + 1_000)).toBe(false);
	});
});

describe("default window/skew params match ADR-0006 (±30s)", () => {
	test("verifyClaimCode defaults to 300s window and ±30s skew", () => {
		const now = START + 1_000;
		const code = deriveClaimCode({ now, serial: SERIAL, secret: SECRET }).code;
		// No windowSeconds/skewSeconds passed → defaults applied.
		expect(
			verifyClaimCode({ code, now, serial: SERIAL, secret: SECRET }),
		).toBe(true);
		// Just past the default +30s band the previous code drops out.
		expect(
			verifyClaimCode({
				code,
				now: BOUNDARY + SKEW_MS,
				serial: SERIAL,
				secret: SECRET,
			}),
		).toBe(false);
	});
});
