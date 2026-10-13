import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
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
let root: string | undefined;
let loads = 0;

afterEach(() => {
	process.chdir(cwd);
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

type Auth = typeof import("../rpc/procedures/auth.procedure.ts");

/** A fresh module instance reading `auth_tokens.json` from a private CWD. */
async function freshAuth(): Promise<Auth> {
	loads += 1;
	const auth: Auth = await import(
		`../rpc/procedures/auth.procedure.ts?store=${loads}`
	);
	auth.setPasswordHash(
		Bun.password.hashSync("correct-password", { algorithm: "bcrypt", cost: 4 }),
	);
	return auth;
}

function socket(): { context: RPCContext; authed: () => boolean } {
	let authenticated = false;
	// Transport double; no listener is opened.
	const context = {
		authenticate: () => {
			authenticated = true;
		},
		isAuthenticated: () => authenticated,
		markActive: () => {},
	} as unknown as RPCContext;
	return { context, authed: () => authenticated };
}

function digest(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function useRoot(): string {
	root = mkdtempSync(join(tmpdir(), "auth-store-"));
	process.chdir(root);
	return root;
}

test.each(["", "{", '{"other":"yes"}'])(
	"a damaged token file %p is archived before a remembered login starts a fresh record",
	async (bytes) => {
		// Given damaged remembered memberships and a separately valid password.
		const dir = useRoot();
		writeFileSync(join(dir, "auth_tokens.json"), bytes);
		const auth = await freshAuth();
		const { context, authed } = socket();
		// When the real password login asks to remember the session.
		const result = await call(
			auth.loginProcedure,
			{ password: "correct-password", persistent_token: true },
			{ context },
		);
		// Then the password still signs in and the damaged bytes survive as a copy.
		expect(result.success).toBe(true);
		expect(authed()).toBe(true);
		const copies = readdirSync(dir).filter((n) =>
			n.startsWith("auth_tokens.json.damaged-"),
		);
		expect(copies).toHaveLength(1);
		expect(readFileSync(join(dir, copies[0] ?? "-"), "utf8")).toBe(bytes);
		expect(
			JSON.parse(readFileSync(join(dir, "auth_tokens.json"), "utf8")),
		).toEqual({ [digest(result.auth_token ?? "")]: true });
	},
);

test("an unreadable token store yields a temporary session and writes nothing", async () => {
	// Given a token store that cannot be read as a regular file.
	const dir = useRoot();
	mkdirSync(join(dir, "auth_tokens.json"));
	writeFileSync(join(dir, "auth_tokens.json", "evidence"), "kept");
	const auth = await freshAuth();
	const { context } = socket();
	// When the correct password asks for a remembered session.
	const result = await call(
		auth.loginProcedure,
		{ password: "correct-password", persistent_token: true },
		{ context },
	);
	// Then the session works for this visit, and nothing replaced the store.
	expect(result.success).toBe(true);
	expect(
		await call(
			auth.loginProcedure,
			{ token: result.auth_token, persistent_token: false },
			{ context },
		),
	).toEqual({ success: true });
	expect(readdirSync(join(dir, "auth_tokens.json"))).toEqual(["evidence"]);
	expect(readdirSync(dir).some((n) => n.includes(".damaged-"))).toBe(false);
});

test("a store that becomes readable is reread on the next login", async () => {
	// Given a store unreadable at import time that is repaired afterwards.
	const dir = useRoot();
	mkdirSync(join(dir, "auth_tokens.json"));
	const auth = await freshAuth();
	rmSync(join(dir, "auth_tokens.json"), { recursive: true });
	const remembered = "remembered-browser-token";
	writeFileSync(
		join(dir, "auth_tokens.json"),
		JSON.stringify({ [digest(remembered)]: true, [digest("other")]: true }),
	);
	const { context } = socket();
	// When a remembered browser reconnects, then a new remembered login happens.
	const reconnect = await call(
		auth.loginProcedure,
		{ token: remembered, persistent_token: false },
		{ context },
	);
	const fresh = await call(
		auth.loginProcedure,
		{ password: "correct-password", persistent_token: true },
		{ context },
	);
	// Then the existing memberships authenticate and are kept beside the new one.
	expect(reconnect).toEqual({ success: true });
	expect(
		Object.keys(
			JSON.parse(readFileSync(join(dir, "auth_tokens.json"), "utf8")),
		).sort(),
	).toEqual(
		[
			digest(remembered),
			digest("other"),
			digest(fresh.auth_token ?? ""),
		].sort(),
	);
});

test("genuine absence still creates the store on a remembered login", async () => {
	// Given no token file at all (a first boot).
	const dir = useRoot();
	const auth = await freshAuth();
	const { context } = socket();
	// When the operator logs in and asks to be remembered.
	const result = await call(
		auth.loginProcedure,
		{ password: "correct-password", persistent_token: true },
		{ context },
	);
	// Then exactly that membership is persisted.
	expect(
		JSON.parse(readFileSync(join(dir, "auth_tokens.json"), "utf8")),
	).toEqual({ [digest(result.auth_token ?? "")]: true });
});
