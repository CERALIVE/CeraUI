// @vitest-environment jsdom
/**
 * The browser stores a REVOCABLE TOKEN, never the operator's password.
 *
 * BEFORE: `Auth.svelte` did `localStorage.setItem('auth', password)` on a
 * remembered login, `SystemHelper.savePassword` did the same on a password
 * change, and the reconnect path resent that value as `input.password`. So the
 * device's only remember-me credential was a permanent one — retiring it meant
 * changing the password everywhere — and it sat in plaintext in browser storage.
 *
 * AFTER: the persistent login's `auth_token` is what is stored, it
 * authenticates through `auth.login`'s TOKEN branch, and `auth.revokeToken`
 * can retire it on its own.
 *
 * Two legs, because neither catches the other: a BEHAVIOURAL one over the real
 * components/stores, and a SOURCE grep that catches a fourth writer nobody
 * thought to mount here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `Auth.svelte` pulls in the PWA store, which calls `window.matchMedia` at
// MODULE scope — before any `beforeEach` could install one. Hoisted so it exists
// by the time the import graph is evaluated.
vi.hoisted(() => {
	globalThis.window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		onchange: null,
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
});

import Auth from "../main/Auth.svelte";

const PASSWORD = "correct-horse-battery";
const ISSUED_TOKEN = "opaque-device-issued-token";

const login = vi.fn();
const setPassword = vi.fn();
const revokeToken = vi.fn();

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: {
			login: (input: unknown) => login(input),
			setPassword: (input: unknown) => setPassword(input),
			revokeToken: (input: unknown) => revokeToken(input),
		},
	},
	rpcClient: {
		isConnected: () => true,
		getConnectionState: () => "connected",
		onConnectionChange: () => () => {},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
	getNotifications: () => undefined,
}));

beforeEach(() => {
	localStorage.clear();
	login.mockReset();
	setPassword.mockReset();
	revokeToken.mockReset();
});

async function authStatus() {
	return await import("$lib/stores/auth-status.svelte");
}

/** Drive the REAL sign-in form: the remember-me write is the component's own. */
async function signIn({ remember }: { remember: boolean }): Promise<void> {
	render(Auth);

	if (remember) {
		await fireEvent.click(screen.getByRole("checkbox"));
	}
	await fireEvent.input(document.getElementById("password") as HTMLElement, {
		target: { value: PASSWORD },
	});
	await fireEvent.submit(
		(document.getElementById("password") as HTMLElement).closest(
			"form",
		) as HTMLElement,
	);
	await waitFor(() => expect(login).toHaveBeenCalled());
	await waitFor(() => {});
}

function browserStorageContents(): string {
	return [
		...Object.keys(localStorage).map((key) => localStorage.getItem(key)),
		...Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key)),
	].join("\u0000");
}

describe("remember-me persists a token, not a password", () => {
	it("stores the issued auth_token when the operator asks to be remembered", async () => {
		login.mockResolvedValue({ success: true, auth_token: ISSUED_TOKEN });

		await signIn({ remember: true });

		expect(login).toHaveBeenCalledWith({
			password: PASSWORD,
			persistent_token: true,
		});
		await waitFor(() =>
			expect(localStorage.getItem("auth")).toBe(ISSUED_TOKEN),
		);
	});

	it("NEVER writes the password into any browser storage", async () => {
		login.mockResolvedValue({ success: true, auth_token: ISSUED_TOKEN });

		await signIn({ remember: true });
		await waitFor(() =>
			expect(localStorage.getItem("auth")).toBe(ISSUED_TOKEN),
		);

		const stored = browserStorageContents();
		expect(stored).not.toContain(PASSWORD);
		// Non-vacuity: the token really did land, so the assertion above is not
		// passing merely because nothing was written at all.
		expect(stored).toContain(ISSUED_TOKEN);
	});

	it("writes nothing at all for an unremembered login", async () => {
		login.mockResolvedValue({ success: true, auth_token: ISSUED_TOKEN });

		await signIn({ remember: false });

		expect(login).toHaveBeenCalledWith({
			password: PASSWORD,
			persistent_token: false,
		});
		expect(localStorage.getItem("auth")).toBeNull();
	});

	it("a password change CLEARS the stored credential", async () => {
		localStorage.setItem("auth", ISSUED_TOKEN);
		setPassword.mockResolvedValue({ success: true });

		const { savePassword } = await import("$lib/helpers/SystemHelper");
		await savePassword("a-brand-new-password");

		expect(setPassword).toHaveBeenCalledWith({
			password: "a-brand-new-password",
		});
		expect(localStorage.getItem("auth")).toBeNull();
	});

	it("revokePersistentToken retires the credential on the DEVICE", async () => {
		revokeToken.mockResolvedValue({ success: true, revoked: 1 });
		const mod = await authStatus();

		await mod.revokePersistentToken(ISSUED_TOKEN);

		expect(revokeToken).toHaveBeenCalledWith({
			token: ISSUED_TOKEN,
			scope: "token",
		});
	});

	it("a refused revoke never throws — the local clear must not be blocked", async () => {
		revokeToken.mockRejectedValue(new Error("unauthorized"));
		const mod = await authStatus();

		await expect(
			mod.revokePersistentToken(ISSUED_TOKEN),
		).resolves.toBeUndefined();
	});
});

describe("no shipped source writes a password into browser storage", () => {
	const SRC = join(import.meta.dirname, "..");

	const READ = (relative: string) => readFileSync(join(SRC, relative), "utf8");

	it("Auth.svelte stores the issued token, not the password", () => {
		const source = READ("main/Auth.svelte");

		expect(source).toContain(
			"localStorage.setItem('auth', message.auth_token)",
		);
		expect(source).not.toContain("localStorage.setItem('auth', password)");
	});

	it("SystemHelper removes the credential on a password change", () => {
		const source = READ("lib/helpers/SystemHelper.ts");

		expect(source).toContain('localStorage.removeItem("auth")');
		expect(source).not.toContain('localStorage.setItem("auth", password)');
	});

	it("the reconnect path authenticates by TOKEN, never as a password", () => {
		const source = READ("lib/rpc/subscriptions.svelte.ts");

		expect(source).toContain(
			"rpc.auth.login({ token, persistent_token: true })",
		);
		expect(source).not.toContain("password: token");
	});
});
