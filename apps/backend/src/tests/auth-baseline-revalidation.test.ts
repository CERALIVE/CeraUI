import { afterEach, expect, spyOn, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import type { RPCContext } from "../rpc/types.ts";

const cwd = process.cwd();
let root: string;
let imports = 0;
afterEach(() => {
	process.chdir(cwd);
	rmSync(root, { recursive: true, force: true });
});
function digest(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
async function fixture(bytes: string) {
	root = mkdtempSync(join(tmpdir(), "auth-revalidation-"));
	process.chdir(root);
	writeFileSync("auth_tokens.json", bytes);
	const auth: typeof import("../rpc/procedures/auth.procedure.ts") =
		await import(
			`../rpc/procedures/auth.procedure.ts?revalidation=${++imports}`
		);
	auth.setPasswordHash(
		Bun.password.hashSync("correct-password", { algorithm: "bcrypt", cost: 4 }),
	);
	let authed = false;
	const context = {
		authenticate: () => {
			authed = true;
		},
		deauthenticate: () => {
			authed = false;
		},
		isAuthenticated: () => authed,
		markActive: () => {},
		ws: { data: {} },
	} as RPCContext;
	return { auth, context };
}

test("remembered login preserves memberships repaired after damaged import", async () => {
	// Given damage cached at import, then newer valid membership authority.
	const { auth, context } = await fixture("{");
	const kept = {
		[digest("remembered-browser")]: true,
		[digest("other-browser")]: true,
	};
	writeFileSync("auth_tokens.json", JSON.stringify(kept));
	// When correct-password login asks for another remembered membership.
	const result = await call(
		auth.loginProcedure,
		{ password: "correct-password", persistent_token: true },
		{ context },
	);
	// Then both repaired memberships survive and no stale corruption is archived.
	expect(result.success).toBe(true);
	expect(JSON.parse(readFileSync("auth_tokens.json", "utf8"))).toEqual({
		...kept,
		[digest(result.auth_token ?? "")]: true,
	});
	expect(readdirSync(root).filter((n) => n.includes(".damaged-"))).toEqual([]);
	expect(
		await call(
			auth.loginProcedure,
			{ token: "remembered-browser", persistent_token: false },
			{ context },
		),
	).toEqual({ success: true });
});

test("explicit revoke-all archives the damaged bytes actually replaced, not cached damage", async () => {
	// Given one damaged baseline at import, replaced by different damage before action.
	const { auth, context } = await fixture("{");
	await call(
		auth.loginProcedure,
		{ password: "correct-password", persistent_token: false },
		{ context },
	);
	writeFileSync("auth_tokens.json", '{"newer":');
	// When the authenticated operator explicitly revokes everything.
	expect(
		(await call(auth.revokeTokenProcedure, { scope: "all" }, { context }))
			.success,
	).toBe(true);
	// Then actual replaced evidence is preserved and the explicit empty result is stored.
	expect(readFileSync("auth_tokens.json", "utf8")).toBe("{}");
	const copies = readdirSync(root).filter((n) => n.includes(".damaged-"));
	expect(copies).toHaveLength(1);
	expect(readFileSync(join(root, copies[0] ?? "missing"), "utf8")).toBe(
		'{"newer":',
	);
});

test("a repair landing while the password is verified is the remembered-login baseline", async () => {
	// Given damage when the login starts, repaired during its password verification await.
	const { auth, context } = await fixture("{");
	const kept = { [digest("repaired-during-verify")]: true };
	const verify = spyOn(Bun.password, "verify").mockImplementation(async () => {
		writeFileSync("auth_tokens.json", JSON.stringify(kept));
		return true;
	});
	try {
		// When the remembered login reaches its write.
		const result = await call(
			auth.loginProcedure,
			{ password: "correct-password", persistent_token: true },
			{ context },
		);
		// Then the write starts from the repaired file, not the damage seen at start.
		expect(JSON.parse(readFileSync("auth_tokens.json", "utf8"))).toEqual({
			...kept,
			[digest(result.auth_token ?? "")]: true,
		});
		expect(readdirSync(root).filter((n) => n.includes(".damaged-"))).toEqual(
			[],
		);
	} finally {
		verify.mockRestore();
	}
});
