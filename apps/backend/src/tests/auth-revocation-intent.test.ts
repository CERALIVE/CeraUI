import { afterEach, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import * as cryptoHelpers from "../helpers/crypto.ts";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import type { RPCContext } from "../rpc/types.ts";

type Auth = typeof import("../rpc/procedures/auth.procedure.ts");
const cwd = process.cwd();
const token = "lost-remembered-browser";
const other = "other-remembered-browser";
const digest = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
let root: string;
let storeDir: string;
let auth: Auth;
let loads = 0;

afterEach(() => {
	auth?.stopLegacyTokenMigration();
	chmodSync(storeDir, 0o700);
	chmodSync(join(storeDir, "auth_tokens.json"), 0o600);
	process.chdir(cwd);
	setConfigFilePath("config.json");
	rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	root = mkdtempSync(join(tmpdir(), "auth-revocation-"));
	storeDir = join(root, "tokens");
	mkdirSync(storeDir, { mode: 0o700 });
	process.chdir(storeDir);
	writeFileSync(
		"auth_tokens.json",
		JSON.stringify({ [digest(token)]: true, [digest(other)]: true }),
	);
	writeFileSync(join(root, "config.json"), "{}");
	setConfigFilePath(join(root, "config.json"));
	await loadConfig();
	auth = await import(
		`../rpc/procedures/auth.procedure.ts?revocation=${++loads}`
	);
	auth.setPasswordHash(
		Bun.password.hashSync("correct-password", { algorithm: "bcrypt", cost: 4 }),
	);
	const data = { authToken: token, isAuthenticated: true };
	// Transport-only double; procedures run unchanged and no listener is opened.
	const context = {
		ws: { data },
		isAuthenticated: () => data.isAuthenticated,
		authenticate: (next?: string) => {
			data.isAuthenticated = true;
			if (next) data.authToken = next;
		},
		deauthenticate: () => {
			data.isAuthenticated = false;
		},
		markActive: () => {},
	} as RPCContext;
	return context;
}

async function login(context: RPCContext, value = token) {
	return call(
		auth.loginProcedure,
		{ token: value, persistent_token: false },
		{ context },
	);
}

test.each(["all", "password", "logout", "single"] as const)(
	"failed %s persistence never restores revoked membership on the next request",
	async (action) => {
		// Given actual remembered memberships and a writable independent config.
		const context = await fixture();
		const before = readFileSync("auth_tokens.json", "utf8");
		// When the atomic token write fails (EACCES stands in for ENOSPC/EIO).
		chmodSync(storeDir, 0o500);
		let result: Promise<unknown>;
		switch (action) {
			case "all":
				result = call(auth.revokeTokenProcedure, { scope: "all" }, { context });
				break;
			case "password":
				result = call(
					auth.setPasswordProcedure,
					{ password: "new-password" },
					{ context },
				);
				break;
			case "logout":
				result = call(auth.logoutProcedure, undefined, { context });
				break;
			case "single":
				result = call(
					auth.revokeTokenProcedure,
					{ scope: "token", token },
					{ context },
				);
				break;
		}
		await expect(result).rejects.toThrow();
		// Then repeated rereads deny the old token and preserve failed-write evidence.
		for (let n = 0; n < 3; n++)
			expect(await login(context)).toEqual({ success: false });
		expect(readFileSync("auth_tokens.json", "utf8")).toBe(before);
		const fresh = await call(
			auth.loginProcedure,
			{
				password: action === "password" ? "new-password" : "correct-password",
				persistent_token: true,
			},
			{ context },
		);
		expect(fresh.success).toBe(true);
		expect(readFileSync("auth_tokens.json", "utf8")).toBe(before);
		expect(await login(context)).toEqual({ success: false });
		chmodSync(storeDir, 0o700);
		expect(await login(context)).toEqual({ success: false });
		expect(JSON.parse(readFileSync("auth_tokens.json", "utf8"))).toEqual(
			action === "all" || action === "password"
				? {}
				: { [digest(other)]: true },
		);
	},
);

test("logout registers revocation before an unreadable membership reread", async () => {
	// Given an authenticated browser and temporarily unreadable token authority.
	const context = await fixture();
	const before = readFileSync("auth_tokens.json", "utf8");
	chmodSync("auth_tokens.json", 0o000);
	// When logout cannot revalidate the persistent record.
	expect(await call(auth.logoutProcedure, undefined, { context })).toEqual({
		success: true,
	});
	// Then later readable authority cannot re-admit it, even while retry writes fail.
	chmodSync("auth_tokens.json", 0o600);
	chmodSync(storeDir, 0o500);
	expect(await login(context)).toEqual({ success: false });
	expect(await login(context)).toEqual({ success: false });
	expect(readFileSync("auth_tokens.json", "utf8")).toBe(before);
	chmodSync(storeDir, 0o700);
	expect(await login(context)).toEqual({ success: false });
	expect(JSON.parse(readFileSync("auth_tokens.json", "utf8"))).toEqual({
		[digest(other)]: true,
	});
});

test("auth shutdown disarms pending revocation retries without restoring membership", async () => {
	// Given a failed revoke-all and an auth operation's scheduled settle microtask.
	const context = await fixture();
	const before = readFileSync("auth_tokens.json", "utf8");
	chmodSync(storeDir, 0o500);
	await expect(
		call(auth.revokeTokenProcedure, { scope: "all" }, { context }),
	).rejects.toThrow();
	// When shutdown stops the retry owner before storage is repaired.
	auth.stopLegacyTokenMigration();
	chmodSync(storeDir, 0o700);
	// Then late auth requests remain denied but submit no retry write.
	expect(await login(context)).toEqual({ success: false });
	expect(readFileSync("auth_tokens.json", "utf8")).toBe(before);
});

test("remembered issuance cannot put a revoked digest back into a successful write", async () => {
	// Given a failed individual revocation and a deterministic token-issuance collision.
	const context = await fixture();
	chmodSync(storeDir, 0o500);
	await expect(
		call(auth.revokeTokenProcedure, { scope: "token", token }, { context }),
	).rejects.toThrow();
	const random = spyOn(cryptoHelpers, "randomBase64").mockReturnValue(token);
	const verify = spyOn(Bun.password, "verify").mockImplementation(async () => {
		chmodSync(storeDir, 0o700);
		return true;
	});
	try {
		// When issuance revalidates during password verification after a failed settle retry.
		await call(
			auth.loginProcedure,
			{ password: "correct-password", persistent_token: true },
			{ context },
		);
		// Then save applies outstanding revocation to additions as well as reread memberships.
		expect(JSON.parse(readFileSync("auth_tokens.json", "utf8"))).toEqual({
			[digest(other)]: true,
		});
		expect(await login(context)).toEqual({ success: false });
	} finally {
		random.mockRestore();
		verify.mockRestore();
	}
});

test("remembered login stays temporary while revoke-all persistence is pending", async () => {
	// Given failed revoke-all persistence, with storage repaired during verification.
	const context = await fixture();
	const before = readFileSync("auth_tokens.json", "utf8");
	chmodSync(storeDir, 0o500);
	await expect(
		call(auth.revokeTokenProcedure, { scope: "all" }, { context }),
	).rejects.toThrow();
	const verify = spyOn(Bun.password, "verify").mockImplementation(async () => {
		chmodSync(storeDir, 0o700);
		return true;
	});
	try {
		// When password login reaches issuance before the next successful settle retry.
		const issued = await call(
			auth.loginProcedure,
			{ password: "correct-password", persistent_token: true },
			{ context },
		);
		// Then it remains a usable temporary session; issuance never replaces membership.
		expect(issued.success).toBe(true);
		expect(readFileSync("auth_tokens.json", "utf8")).toBe(before);
		expect(await login(context, issued.auth_token)).toEqual({ success: true });
		expect(readFileSync("auth_tokens.json", "utf8")).toBe("{}");
		expect(await login(context)).toEqual({ success: false });
	} finally {
		verify.mockRestore();
	}
});
