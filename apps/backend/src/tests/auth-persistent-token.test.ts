/*
 * The remember-me credential is a REVOCABLE TOKEN, and the device stores only a
 * digest of it.
 *
 * BEFORE: the browser persisted the operator's PLAINTEXT PASSWORD under
 * `localStorage.auth` and resent it as `input.password` on every reconnect, and
 * `auth_tokens.json` held its tokens VERBATIM. Two consequences:
 *
 *   1. A remembered browser held a permanent credential nothing could retire.
 *      Revoking it meant changing the password everywhere.
 *   2. Anything that could read `auth_tokens.json` held a working credential for
 *      every remembered browser.
 *
 * AFTER: a persistent login returns an opaque token, the device stores
 * `sha256(token)`, and `auth.revokeToken` retires one credential or all of them.
 * A password change revokes every outstanding credential.
 *
 * The store is module-scope in `auth.procedure.ts`, so this suite drives the
 * REAL procedures through `call()` against a temp working directory — the file
 * on disk is part of the contract, not an implementation detail.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";

const AUTH_TOKENS_FILE = "auth_tokens.json";
const PASSWORD = "correct-horse-battery";
const NEXT_PASSWORD = "staple-horse-battery";

const workDir = mkdtempSync(join(tmpdir(), "ceraui-auth-"));
const originalCwd = process.cwd();

// A pre-migration file: raw tokens as keys. It must not survive the load.
writeFileSync(
	join(workDir, AUTH_TOKENS_FILE),
	JSON.stringify({ "legacy-raw-token-value": true }),
);
process.chdir(workDir);

const {
	loginProcedure,
	logoutProcedure,
	revokeTokenProcedure,
	setPasswordProcedure,
	setPasswordHash,
} = await import("../rpc/procedures/auth.procedure.ts");

afterAll(() => {
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
});

/** A minimal RPCContext double: only the auth surface these procedures touch. */
function makeContext(): {
	isAuthenticated: () => boolean;
	authenticate: (token?: string) => void;
	deauthenticate: () => void;
	markActive: () => void;
	ws: { data: { authToken?: string; isAuthenticated: boolean } };
} {
	const data: { authToken?: string; isAuthenticated: boolean } = {
		isAuthenticated: false,
	};
	return {
		isAuthenticated: () => data.isAuthenticated,
		authenticate: (token?: string) => {
			data.isAuthenticated = true;
			if (token !== undefined) data.authToken = token;
		},
		deauthenticate: () => {
			data.isAuthenticated = false;
			data.authToken = undefined;
		},
		markActive: () => {},
		ws: { data },
	};
}

// biome-ignore lint/suspicious/noExplicitAny: the procedures take the full RPCContext; this double carries only the auth surface they touch.
const asContext = (ctx: ReturnType<typeof makeContext>) => ctx as any;

function readTokenFile(): Record<string, true> {
	try {
		return JSON.parse(readFileSync(join(workDir, AUTH_TOKENS_FILE), "utf8"));
	} catch {
		return {};
	}
}

const sha256 = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function login(
	ctx: ReturnType<typeof makeContext>,
	input: { password?: string; token?: string; persistent_token?: boolean },
) {
	return call(
		loginProcedure,
		{ persistent_token: false, ...input },
		{ context: asContext(ctx) },
	);
}

beforeAll(() => {
	setPasswordHash(
		Bun.password.hashSync(PASSWORD, { algorithm: "bcrypt", cost: 10 }),
	);
});

describe("a persistent credential is a token, stored as a digest", () => {
	// Asserted as an INVARIANT rather than as a load-time event: `bun test` runs
	// every file in one process, so an earlier file may already have imported the
	// module-scope token store and the prune has then run against a different
	// working directory. The property that matters holds in any load order.
	it("never leaves a non-digest record on disk", async () => {
		const ctx = makeContext();
		await login(ctx, { password: PASSWORD, persistent_token: true });

		const keys = Object.keys(readTokenFile());
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("a pre-digest record is inert — the raw token does not authenticate", async () => {
		const ctx = makeContext();

		expect(
			(await login(ctx, { token: "legacy-raw-token-value" })).success,
		).toBe(false);
		expect(ctx.isAuthenticated()).toBe(false);
	});

	it("round-trips: issue -> persist -> reconnect authenticates by TOKEN", async () => {
		const first = makeContext();
		const issued = await login(first, {
			password: PASSWORD,
			persistent_token: true,
		});

		expect(issued.success).toBe(true);
		expect(typeof issued.auth_token).toBe("string");
		const token = issued.auth_token ?? "";
		expect(token.length).toBeGreaterThan(0);

		// A fresh socket — the reconnect case — authenticates on the token alone.
		const reconnected = makeContext();
		const resumed = await login(reconnected, { token });
		expect(resumed.success).toBe(true);
		expect(reconnected.isAuthenticated()).toBe(true);
	});

	it("stores the DIGEST, never the token", async () => {
		const ctx = makeContext();
		const { auth_token: token } = await login(ctx, {
			password: PASSWORD,
			persistent_token: true,
		});
		const raw = readFileSync(join(workDir, AUTH_TOKENS_FILE), "utf8");

		expect(token).toBeDefined();
		expect(raw).not.toContain(token ?? "__absent__");
		expect(raw).toContain(sha256(token ?? ""));
	});

	it("refuses a token it never issued", async () => {
		const ctx = makeContext();
		const rejected = await login(ctx, { token: "not-a-token-we-minted" });

		expect(rejected.success).toBe(false);
		expect(ctx.isAuthenticated()).toBe(false);
	});

	it("a NON-persistent login is not written to disk", async () => {
		const before = Object.keys(readTokenFile()).length;
		const ctx = makeContext();
		const { auth_token: token } = await login(ctx, {
			password: PASSWORD,
			persistent_token: false,
		});

		expect(token).toBeDefined();
		expect(Object.keys(readTokenFile())).toHaveLength(before);

		// …but it still authenticates for this process's lifetime.
		const resumed = makeContext();
		expect((await login(resumed, { token })).success).toBe(true);
	});
});

describe("revocation", () => {
	it("a revoked token no longer authenticates", async () => {
		const owner = makeContext();
		const { auth_token: token } = await login(owner, {
			password: PASSWORD,
			persistent_token: true,
		});

		const revoked = await call(
			revokeTokenProcedure,
			{ token, scope: "token" },
			{ context: asContext(owner) },
		);
		expect(revoked).toEqual({ success: true, revoked: 1 });

		const retry = makeContext();
		expect((await login(retry, { token })).success).toBe(false);
	});

	it("revoking an already-gone credential SUCCEEDS with revoked: 0", async () => {
		const owner = makeContext();
		await login(owner, { password: PASSWORD, persistent_token: true });

		const result = await call(
			revokeTokenProcedure,
			{ token: "a-token-that-was-never-issued", scope: "token" },
			{ context: asContext(owner) },
		);

		expect(result).toEqual({ success: true, revoked: 0 });
	});

	it("revoking ANOTHER browser's token does NOT sign the caller out", async () => {
		const other = makeContext();
		const { auth_token: otherToken } = await login(other, {
			password: PASSWORD,
			persistent_token: true,
		});

		const caller = makeContext();
		await login(caller, { password: PASSWORD, persistent_token: true });

		await call(
			revokeTokenProcedure,
			{ token: otherToken, scope: "token" },
			{ context: asContext(caller) },
		);

		expect(caller.isAuthenticated()).toBe(true);
		expect((await login(makeContext(), { token: otherToken })).success).toBe(
			false,
		);
	});

	it("scope: 'all' is log-out-everywhere", async () => {
		const a = makeContext();
		const b = makeContext();
		const { auth_token: tokenA } = await login(a, {
			password: PASSWORD,
			persistent_token: true,
		});
		const { auth_token: tokenB } = await login(b, {
			password: PASSWORD,
			persistent_token: true,
		});

		const result = await call(
			revokeTokenProcedure,
			{ scope: "all" },
			{ context: asContext(a) },
		);
		expect(result.success).toBe(true);
		expect(result.revoked).toBeGreaterThanOrEqual(2);

		expect((await login(makeContext(), { token: tokenA })).success).toBe(false);
		expect((await login(makeContext(), { token: tokenB })).success).toBe(false);
		expect(readTokenFile()).toEqual({});
	});

	it("refuses an unauthenticated caller, and revokes nothing", async () => {
		const owner = makeContext();
		const { auth_token: token } = await login(owner, {
			password: PASSWORD,
			persistent_token: true,
		});

		const stranger = makeContext();
		const refused = await call(
			revokeTokenProcedure,
			{ scope: "all" },
			{ context: asContext(stranger) },
		);

		expect(refused).toEqual({ success: false, revoked: 0 });
		expect((await login(makeContext(), { token })).success).toBe(true);
	});

	it("logout revokes only the calling socket's own credential", async () => {
		const mine = makeContext();
		const theirs = makeContext();
		const { auth_token: myToken } = await login(mine, {
			password: PASSWORD,
			persistent_token: true,
		});
		const { auth_token: theirToken } = await login(theirs, {
			password: PASSWORD,
			persistent_token: true,
		});

		await call(logoutProcedure, undefined, { context: asContext(mine) });

		expect((await login(makeContext(), { token: myToken })).success).toBe(
			false,
		);
		expect((await login(makeContext(), { token: theirToken })).success).toBe(
			true,
		);
	});
});

describe("a password change retires every outstanding credential", () => {
	it("revokes them all and keeps the changing socket signed in", async () => {
		const operator = makeContext();
		const elsewhere = makeContext();
		await login(operator, { password: PASSWORD, persistent_token: true });
		const { auth_token: strandedToken } = await login(elsewhere, {
			password: PASSWORD,
			persistent_token: true,
		});

		const changed = await call(
			setPasswordProcedure,
			{ password: NEXT_PASSWORD },
			{ context: asContext(operator) },
		);
		expect(changed).toEqual({ success: true });

		// The device a lost phone was signed in on is signed out.
		expect((await login(makeContext(), { token: strandedToken })).success).toBe(
			false,
		);
		expect(readTokenFile()).toEqual({});

		// …and the operator who just changed it is not thrown out.
		expect(operator.isAuthenticated()).toBe(true);

		const withNew = makeContext();
		expect((await login(withNew, { password: NEXT_PASSWORD })).success).toBe(
			true,
		);
		expect((await login(makeContext(), { password: PASSWORD })).success).toBe(
			false,
		);
	});
});
