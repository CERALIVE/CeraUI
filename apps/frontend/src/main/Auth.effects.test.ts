// @vitest-environment jsdom
/**
 * Auth.svelte — behaviour lock for the two device-feed effects.
 *
 * Both effects carry a SIDE EFFECT (a `localStorage.removeItem('auth')` and a
 * loading-state clear) beside the state they mirror, so they are the C3
 * anti-pattern the experience-stability plan names. These cases pin the
 * OBSERVABLE contract they must keep across that refactor:
 *
 *   1. the device's `set_password` verdict decides which form is on screen, and
 *      a device that asks for a password wipes any stored credential;
 *   2. a later verdict moves the form again (the feed is authoritative);
 *   3. an `auth` notification ends the in-flight submit, wipes the stored
 *      credential, and surfaces the rejection INLINE (never a toast);
 *   4. that inline error survives while the field still holds the value the
 *      device rejected.
 *
 * All four are green on the pre-change tree — this is a refactor lock, not a
 * bug fix.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getNotificationsFeed,
	getStatusFeed,
	publishNotifications,
	publishStatus,
	resetAuthFeeds,
} from "./__fixtures__/auth-feed.svelte";
import Auth from "./Auth.svelte";

const authenticate = vi.hoisted(() => vi.fn());
const createPassword = vi.hoisted(() => vi.fn());

vi.mock("$lib/config", () => ({
	deviceName: "CeraLive",
	siteName: "ceralive.tv",
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./__fixtures__/auth-feed.svelte");
	return {
		getStatus: feed.getStatusFeed,
		getNotifications: feed.getNotificationsFeed,
	};
});

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate,
	createPassword,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	getSessionExpired: () => false,
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getConnectionState: () => "connected",
}));

const passwordField = () =>
	document.querySelector<HTMLInputElement>("#password");
const confirmField = () =>
	document.querySelector<HTMLInputElement>("#confirm-password");
const inlineError = () => document.querySelector("#password-error");

beforeEach(() => {
	resetAuthFeeds();
	localStorage.clear();
	authenticate.mockReset();
	createPassword.mockReset();
	authenticate.mockResolvedValue({ kind: "ok" });
	createPassword.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("Auth — the device's set_password verdict", () => {
	it("renders the create-password form and wipes a stored credential", async () => {
		localStorage.setItem("auth", "stale-token");
		render(Auth);

		expect(confirmField()).toBeNull();

		publishStatus({ set_password: true } as never);

		await waitFor(() => expect(confirmField()).not.toBeNull());
		expect(localStorage.getItem("auth")).toBeNull();
		// The feed is what the component read — not a copy it took at mount.
		expect(getStatusFeed()).toEqual({ set_password: true });
	});

	it("moves the form back when the device stops asking", async () => {
		render(Auth);

		publishStatus({ set_password: true } as never);
		await waitFor(() => expect(confirmField()).not.toBeNull());

		publishStatus({ set_password: false } as never);
		await waitFor(() => expect(confirmField()).toBeNull());
	});

	it("leaves a stored credential alone while the device asks for none", async () => {
		localStorage.setItem("auth", "good-token");
		render(Auth);

		publishStatus({ set_password: false } as never);
		await waitFor(() => expect(confirmField()).toBeNull());

		expect(localStorage.getItem("auth")).toBe("good-token");
	});
});

describe("Auth — an `auth` notification is an INLINE rejection", () => {
	async function submitAndStall(password: string) {
		// A never-settling authenticate keeps the submit in flight, which is the
		// state the notification has to clear.
		authenticate.mockReturnValue(new Promise(() => {}));
		render(Auth);
		publishStatus({ set_password: false } as never);

		const field = passwordField();
		expect(field).not.toBeNull();
		await fireEvent.input(field as HTMLInputElement, {
			target: { value: password },
		});
		const form = document.querySelector("form");
		expect(form).not.toBeNull();
		await fireEvent.submit(form as HTMLFormElement);
		await waitFor(() => expect(authenticate).toHaveBeenCalled());
		return field as HTMLInputElement;
	}

	it("ends the submit, wipes the credential, and renders the error inline", async () => {
		localStorage.setItem("auth", "rejected-token");
		const field = await submitAndStall("wrong-pass");

		expect(field.disabled).toBe(true);

		publishNotifications({
			show: [
				{
					name: "auth",
					type: "error",
					msg: "Invalid password",
					is_dismissable: true,
					is_persistent: false,
				},
			],
		} as never);

		await waitFor(() => expect(inlineError()).not.toBeNull());
		expect(field.disabled).toBe(false);
		expect(localStorage.getItem("auth")).toBeNull();
		expect(field.getAttribute("aria-invalid")).toBe("true");
		expect(getNotificationsFeed()?.show?.[0]?.name).toBe("auth");
	});

	it("keeps the error while the field still holds the rejected value", async () => {
		const field = await submitAndStall("wrong-pass");

		publishNotifications({
			show: [
				{
					name: "auth",
					type: "error",
					msg: "Invalid password",
					is_dismissable: true,
					is_persistent: false,
				},
			],
		} as never);
		await waitFor(() => expect(inlineError()).not.toBeNull());

		// Re-rendering for an unrelated device push must not clear the rejection.
		publishStatus({ set_password: false, is_streaming: false } as never);
		await waitFor(() => expect(field.value).toBe("wrong-pass"));
		expect(inlineError()).not.toBeNull();
	});

	it("renders nothing inline for a notification that is not `auth`", async () => {
		render(Auth);
		publishStatus({ set_password: false } as never);

		publishNotifications({
			show: [
				{
					name: "netif_dup_ip",
					type: "warning",
					msg: "Duplicate address",
					is_dismissable: true,
					is_persistent: true,
				},
			],
		} as never);

		await waitFor(() => expect(passwordField()).not.toBeNull());
		expect(inlineError()).toBeNull();
	});
});

describe("Auth — screen.getByRole sanity", () => {
	it("mounts a submit button", () => {
		render(Auth);
		expect(screen.getByRole("button", { name: /unlock|sign/i })).toBeTruthy();
	});
});
