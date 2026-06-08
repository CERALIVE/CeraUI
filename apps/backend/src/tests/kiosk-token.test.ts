/**
 * Kiosk loopback token (DC-3 / docs/KIOSK_TOKEN_CONTRACT.md).
 *
 * The backend mints a single-use, 32-byte hex token to a tmpfs path and accepts
 * it exactly once — over loopback only — in exchange for a session cookie. These
 * tests pin every invariant from the contract:
 *   - positive: loopback + correct token -> 200 + Set-Cookie session
 *   - negative: LAN source IP -> 401 (token file is NOT touched)
 *   - single-use: a second exchange of the same token -> 401
 *   - mismatch: wrong token over loopback -> 401 (and the file is still consumed)
 *   - not-PASETO: the minted token is raw lowercase hex, never a PASETO v4 token
 *   - tmpfs-only: the token path lives under /run, never durable config/cwd
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the tmpfs path into a temp dir so the suite never writes to the real
// /run and never needs root. kioskTokenPath() resolves CERALIVE_RUN_DIR lazily.
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ceralive-kiosk-"));
process.env.CERALIVE_RUN_DIR = RUN_DIR;

import {
	handleKioskTokenExchange,
	isLoopbackIp,
	kioskTokenPath,
	mintKioskToken,
} from "../modules/ui/kiosk-token.ts";

const LOOPBACK = "127.0.0.1";
const LAN = "192.168.1.50";
const SESSION = "test-session-token-abc";

/** Build a GET request that carries the kiosk_token query parameter. */
function exchangeRequest(token: string): Request {
	return new Request(
		`http://127.0.0.1/?mode=touch&display=lcd&kiosk_token=${token}`,
	);
}

/** Count how many times the injected session issuer ran, returning a fixed token. */
function trackedIssuer() {
	let calls = 0;
	const issue = () => {
		calls++;
		return SESSION;
	};
	return {
		issue,
		get calls() {
			return calls;
		},
	};
}

beforeEach(() => {
	// Each test starts from a clean tmpfs dir (no leftover token file).
	for (const entry of fs.readdirSync(RUN_DIR)) {
		fs.rmSync(path.join(RUN_DIR, entry), { recursive: true, force: true });
	}
});

afterAll(() => {
	fs.rmSync(RUN_DIR, { recursive: true, force: true });
	delete process.env.CERALIVE_RUN_DIR;
});

describe("kioskTokenPath / mintKioskToken", () => {
	it("resolves the tmpfs path under the run dir, named kiosk-token", () => {
		const p = kioskTokenPath();
		expect(p).toBe(path.join(RUN_DIR, "kiosk-token"));
		// The real production path is tmpfs (/run) — never durable config or cwd.
		expect(p).not.toContain("config");
		expect(p).not.toBe(path.join(process.cwd(), "kiosk-token"));
	});

	it("mints a 32-byte (64-char) lowercase hex token — NOT a PASETO token", async () => {
		const token = await mintKioskToken();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		// PASETO v4.public tokens are dotted (v4.public.<payload>...); hex has no dots.
		expect(token.includes(".")).toBe(false);
		expect(token.startsWith("v4.")).toBe(false);
		// base64 would contain +/= or uppercase; hex never does.
		expect(token).not.toMatch(/[+/=]/);
	});

	it("writes the token to the tmpfs path with 0600 permissions and no trailing newline", async () => {
		const token = await mintKioskToken();
		const onDisk = fs.readFileSync(kioskTokenPath(), "utf8");
		expect(onDisk).toBe(token);
		expect(onDisk.endsWith("\n")).toBe(false);
		const mode = fs.statSync(kioskTokenPath()).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("mints a fresh, distinct token on each call (single-use rotation)", async () => {
		const a = await mintKioskToken();
		const b = await mintKioskToken();
		expect(a).not.toBe(b);
	});
});

describe("isLoopbackIp", () => {
	it("accepts loopback addresses only", () => {
		expect(isLoopbackIp("127.0.0.1")).toBe(true);
		expect(isLoopbackIp("::1")).toBe(true);
		expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
	});

	it("rejects LAN, public, and missing addresses", () => {
		expect(isLoopbackIp("192.168.1.50")).toBe(false);
		expect(isLoopbackIp("10.0.0.4")).toBe(false);
		expect(isLoopbackIp("172.16.5.9")).toBe(false);
		expect(isLoopbackIp("8.8.8.8")).toBe(false);
		expect(isLoopbackIp(undefined)).toBe(false);
		expect(isLoopbackIp("")).toBe(false);
	});
});

describe("handleKioskTokenExchange", () => {
	it("ignores requests without a kiosk_token param (normal auth flow)", async () => {
		const issuer = trackedIssuer();
		const res = await handleKioskTokenExchange(
			new Request("http://127.0.0.1/?mode=touch"),
			LOOPBACK,
			issuer.issue,
		);
		expect(res).toBeNull();
		expect(issuer.calls).toBe(0);
	});

	it("loopback + correct token -> 200, sets the session cookie, and is single-use", async () => {
		const token = await mintKioskToken();
		const issuer = trackedIssuer();

		const res = await handleKioskTokenExchange(
			exchangeRequest(token),
			LOOPBACK,
			issuer.issue,
		);

		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		const setCookie = res?.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain(`session=${SESSION}`);
		expect(issuer.calls).toBe(1);

		// The token file is invalidated (deleted) before the response is returned.
		expect(fs.existsSync(kioskTokenPath())).toBe(false);
	});

	it("LAN source IP -> 401 loopback_only WITHOUT touching the token file", async () => {
		const token = await mintKioskToken();
		const issuer = trackedIssuer();

		const res = await handleKioskTokenExchange(
			exchangeRequest(token),
			LAN,
			issuer.issue,
		);

		expect(res?.status).toBe(401);
		expect(await res?.json()).toEqual({ error: "loopback_only" });
		expect(issuer.calls).toBe(0);
		// The contract says a non-loopback request is rejected before the file is read.
		expect(fs.existsSync(kioskTokenPath())).toBe(true);
	});

	it("reuse of an already-consumed token -> 401 token_invalid", async () => {
		const token = await mintKioskToken();
		const issuer = trackedIssuer();

		const first = await handleKioskTokenExchange(
			exchangeRequest(token),
			LOOPBACK,
			issuer.issue,
		);
		expect(first?.status).toBe(200);

		const second = await handleKioskTokenExchange(
			exchangeRequest(token),
			LOOPBACK,
			issuer.issue,
		);
		expect(second?.status).toBe(401);
		expect(await second?.json()).toEqual({ error: "token_invalid" });
		expect(issuer.calls).toBe(1);
	});

	it("token mismatch over loopback -> 401 token_invalid and the token is consumed anyway", async () => {
		await mintKioskToken();
		const issuer = trackedIssuer();
		const wrong = "f".repeat(64);

		const res = await handleKioskTokenExchange(
			exchangeRequest(wrong),
			LOOPBACK,
			issuer.issue,
		);

		expect(res?.status).toBe(401);
		expect(await res?.json()).toEqual({ error: "token_invalid" });
		expect(issuer.calls).toBe(0);
		// Invalidation happens regardless of whether the compare succeeded.
		expect(fs.existsSync(kioskTokenPath())).toBe(false);
	});

	it("no token minted (file absent) over loopback -> 401 token_invalid", async () => {
		const issuer = trackedIssuer();
		const res = await handleKioskTokenExchange(
			exchangeRequest("a".repeat(64)),
			LOOPBACK,
			issuer.issue,
		);
		expect(res?.status).toBe(401);
		expect(await res?.json()).toEqual({ error: "token_invalid" });
		expect(issuer.calls).toBe(0);
	});
});
