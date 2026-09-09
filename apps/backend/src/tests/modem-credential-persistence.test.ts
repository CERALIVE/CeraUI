import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modemSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import * as verify from "../modules/modems/modem-credential-verify.ts";
import {
	initModemCredentials,
	readModemCredential,
	resetModemCredentialsForTest,
} from "../modules/modems/modem-credentials.ts";
import { resetModemLockSessionsForTest } from "../modules/modems/modem-lock-state.ts";
import { resolvePhysicalDevice } from "../modules/modems/physical-identity.ts";
import {
	clearModemCredentialsProcedure,
	setModemCredentialsProcedure,
	verifyModemCredentialsProcedure,
} from "../rpc/procedures/modems-credentials.procedure.ts";
import type { RPCContext } from "../rpc/types.ts";
import captured from "./fixtures/modems/zte-mf79u/installed-summary.json";

// The target is today's captured locked ZTE, not an invented router. Login
// outcomes are injected: no credential was submitted during that board capture.
const row = modemSchema.parse(captured.wireRowsMatchedByIdPath["1003"]);
const target: verify.CredentialTarget = {
	ifname: captured.wireRowsMatchedByIdPath["1003"].ifname,
	adminUrl: captured.wireRowsMatchedByIdPath["1003"].router_admin.admin_url,
	dialect: "zte",
	device: resolvePhysicalDevice({
		ifname: captured.wireRowsMatchedByIdPath["1003"].ifname,
		idPath: captured.wireRowsMatchedByIdPath["1003"].stable_key,
		vid: "19d2",
		pid: "1405",
	}),
};
const context: RPCContext = {
	ws: {
		data: { isAuthenticated: true, lastActive: 0 },
		remoteAddress: "127.0.0.1",
		readyState: 1,
		binaryType: "arraybuffer",
		send: () => 0,
		sendText: () => 0,
		sendBinary: () => 0,
		ping: () => 0,
		pong: () => 0,
		publish: () => 0,
		publishText: () => 0,
		publishBinary: () => 0,
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		subscriptions: [],
		cork: () => {},
		close: () => {},
		terminate: () => {},
		getBufferedAmount: () => 0,
	},
	isAuthenticated: () => true,
	authenticate: () => {},
	deauthenticate: () => {},
	markActive: () => {},
	getLastActive: () => 0,
	setSenderId: () => {},
	getSenderId: () => undefined,
	clearSenderId: () => {},
};
const credential = {
	username: "test-operator",
	password: "fixture-only-attempt",
};
let root: string;
let file: string;
const restores: Array<() => void> = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "credential-persistence-"));
	file = join(root, "modem-credentials.json");
	await initModemCredentials(file);
	const resolver = spyOn(verify, "resolveCredentialTarget").mockReturnValue(
		target,
	);
	const depResolver = spyOn(
		verify.defaultCredentialVerifyDeps,
		"resolveTarget",
	).mockReturnValue(target);
	const real = spyOn(
		verify.defaultCredentialVerifyDeps,
		"isRealDevice",
	).mockResolvedValue(true);
	const detect = spyOn(
		verify.defaultRouterLoginPort,
		"detectOpen",
	).mockResolvedValue("locked");
	restores.push(
		() => resolver.mockRestore(),
		() => depResolver.mockRestore(),
		() => real.mockRestore(),
		() => detect.mockRestore(),
	);
	expect(row.lock_state).toBe("locked");
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	resetModemCredentialsForTest();
	resetModemLockSessionsForTest();
	await rm(root, { recursive: true, force: true });
});

function submit(password = credential.password) {
	return call(
		setModemCredentialsProcedure,
		{ device: "1003", ...credential, password },
		{ context },
	);
}

function attempt(
	result: "auth-accepted" | "auth-rejection" | "protocol-mismatch" | "lockout",
) {
	const spy = spyOn(verify.defaultRouterLoginPort, "attempt").mockResolvedValue(
		result,
	);
	restores.push(() => spy.mockRestore());
	return spy;
}

describe("portal credential persistence on the captured ZTE target", () => {
	it.each(["auth-rejection", "protocol-mismatch", "lockout"] as const)(
		"creates no file or temporary file after %s",
		async (result) => {
			// Given an empty real store and a failed login.
			attempt(result);
			const opened = spyOn(fs, "openSync");
			restores.push(() => opened.mockRestore());
			// When the operator submits a password.
			const outcome = await submit();
			// Then no secret-bearing inode was ever opened, not even transiently.
			expect(
				opened.mock.calls.filter(([path]) => String(path).startsWith(root)),
			).toEqual([]);
			expect(await readdir(root)).toEqual([]);
			expect(outcome.success).toBe(false);
			expect(readModemCredential(target.device)).toBeUndefined();
		},
	);

	it("waits for verification before persisting a successful credential at 0600", async () => {
		// Given a login whose completion is controlled independently of submission.
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<"auth-accepted">();
		const login = spyOn(
			verify.defaultRouterLoginPort,
			"attempt",
		).mockImplementation(async () => {
			entered.resolve();
			return reply.promise;
		});
		restores.push(() => login.mockRestore());
		// When submission is pending, nothing may have been written.
		const pending = submit();
		await Promise.race([entered.promise, pending]);
		const beforeConfirmation = await readdir(root);
		reply.resolve("auth-accepted");
		const outcome = await pending;
		// Then the successful completion alone publishes the credential.
		expect(beforeConfirmation).toEqual([]);
		expect(login).toHaveBeenCalledTimes(1);
		expect(outcome.success).toBe(true);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		resetModemCredentialsForTest();
		await initModemCredentials(file);
		expect(readModemCredential(target.device)).toMatchObject({
			...credential,
			lastOutcome: "unlocked",
		});
	});

	it("preserves the previous successful file and credential after a failed replacement", async () => {
		// Given a prior successful submission to the same physical target.
		const login = attempt("auth-accepted");
		await submit("fixture-only-previous");
		const before = await Bun.file(file).text();
		const inode = await stat(file);
		login.mockResolvedValue("auth-rejection");
		// When a different password is rejected.
		await submit();
		// Then both bytes and inode metadata remain unchanged, also after reload.
		expect(await Bun.file(file).text()).toBe(before);
		const after = await stat(file);
		expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
			inode.ino,
			inode.mtimeMs,
			inode.ctimeMs,
		]);
		resetModemCredentialsForTest();
		await initModemCredentials(file);
		expect(readModemCredential(target.device)?.password).toBe(
			"fixture-only-previous",
		);
	});

	it("does not rewrite the store when re-verifying an existing credential fails", async () => {
		// Given an existing successfully verified credential.
		const login = attempt("auth-accepted");
		await submit();
		const before = await Bun.file(file).text();
		const inode = (await stat(file)).ino;
		login.mockResolvedValue("auth-rejection");
		// When the separate verify RPC rejects it.
		await call(
			verifyModemCredentialsProcedure,
			{ device: "1003" },
			{ context },
		);
		// Then the failure path must not serialize the secret store again.
		expect(await Bun.file(file).text()).toBe(before);
		expect((await stat(file)).ino).toBe(inode);
	});

	it("does not resurrect a credential forgotten while verification was pending", async () => {
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<"auth-accepted">();
		const login = spyOn(
			verify.defaultRouterLoginPort,
			"attempt",
		).mockImplementation(() => {
			entered.resolve();
			return reply.promise;
		});
		restores.push(() => login.mockRestore());
		const pending = submit();
		await entered.promise;
		await call(clearModemCredentialsProcedure, { device: "1003" }, { context });
		reply.resolve("auth-accepted");
		const outcome = await pending;
		expect(outcome.success).toBe(false);
		expect(readModemCredential(target.device)).toBeUndefined();
		expect(await readdir(root)).toEqual([]);
	});
});
