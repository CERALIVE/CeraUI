// @vitest-environment jsdom
// allow: SIZE_OK - this lifetime matrix shares one real form and transport fixture.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearAuthInteraction,
	getAuthStatus,
	setAuthStatus,
	subscribeAuthStatus,
} from "../lib/stores/auth-status.svelte";
import { markSessionExpired } from "../lib/stores/connection-ux.svelte";
import {
	publishNotifications,
	publishOffline,
	publishStatus,
	resetAuthFeeds,
} from "./__fixtures__/auth-feed.svelte";
import Layout from "./Layout.svelte";

const transport = vi.hoisted(() => ({
	login: vi.fn(),
	setPassword: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: {
			login: (input: unknown) => transport.login(structuredClone(input)),
			setPassword: (input: unknown) =>
				transport.setPassword(structuredClone(input)),
		},
		ui: { heartbeat: async () => ({ success: true }) },
	},
	rpcClient: {
		isConnected: () => true,
		getConnectionState: () => "connected",
		onConnectionChange: () => () => undefined,
	},
}));
vi.mock("$lib/rpc", async () => ({
	rpc: (await import("../lib/rpc/client")).rpc,
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	clearPasswordSetup: vi.fn(),
	getStatus: (await import("./__fixtures__/auth-feed.svelte")).getStatusFeed,
	getNotifications: (await import("./__fixtures__/auth-feed.svelte"))
		.getNotificationsFeed,
	getUpdating: () => null,
}));
vi.mock("$lib/stores/offline-state.svelte", async () => ({
	getShouldShowOfflinePage: (await import("./__fixtures__/auth-feed.svelte"))
		.getOfflineFeed,
	getConnectionState: () => "connected",
}));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./MainView.svelte", noop);
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("./layout/UpdateOrchestratorBadge.svelte", noop);
vi.mock("$lib/components/updating-overlay.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => ({
	OfflinePage: (await import("../tests/fixtures/OfflinePageStub.svelte"))
		.default,
	PWAStatus: (await import("../tests/fixtures/Noop.svelte")).default,
}));

const field = () => screen.getByLabelText<HTMLInputElement>("Password");
const form = () => {
	const element = document.querySelector("form");
	if (!element) throw new Error("Auth form missing");
	return element;
};
const secret = () => ` ${crypto.randomUUID()} ñ界 `;
const showOfflinePage = () => publishOffline(true);
const hideOfflinePage = () => publishOffline(false);
const enter = (input: HTMLInputElement, value: string) =>
	fireEvent.input(input, { target: { value } });

beforeEach(() => {
	setAuthStatus(false);
	resetAuthFeeds();
	hideOfflinePage();
	transport.login.mockReset();
	transport.setPassword.mockReset();
	localStorage.clear();
});
afterEach(() => {
	clearAuthInteraction();
	hideOfflinePage();
	vi.useRealTimers();
});

async function swap() {
	showOfflinePage();
	await tick();
	expect(screen.getByTestId("offline-page")).not.toBeNull();
	const hiddenOwner = field().closest<HTMLElement>('[aria-hidden="true"]');
	expect(hiddenOwner?.hidden).toBe(true);
	expect(hiddenOwner?.inert).toBe(true);
	hideOfflinePage();
	await tick();
}

describe("Layout auth interaction lifetime", () => {
	it.each([false, true])(
		"keeps exact login input and remember=%s across two takeovers",
		async (remember) => {
			render(Layout);
			const value = secret().repeat(100);
			const input = field();
			await enter(input, value);
			if (remember) await fireEvent.click(screen.getByRole("checkbox"));
			await fireEvent.click(screen.getByTestId("auth-password-visibility"));
			await swap();
			expect(field() === input).toBe(true);
			expect(field().value === value).toBe(true);
			expect(field().type).toBe("password");
			expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
				String(remember),
			);
			const edited = secret();
			await enter(field(), edited);
			await swap();
			expect(field().value === edited).toBe(true);
			expect(transport.login.mock.calls.length).toBe(0);
			expect(
				Object.values(localStorage).some((entry) =>
					String(entry).includes(edited),
				),
			).toBe(false);
			expect(
				Object.values(sessionStorage).some((entry) =>
					String(entry).includes(edited),
				),
			).toBe(false);
		},
	);

	it("keeps pending ownership and rejection equality through an offline swap", async () => {
		const result = Promise.withResolvers<{ success: boolean }>();
		transport.login.mockReturnValue(result.promise);
		render(Layout);
		const rejected = secret();
		await enter(field(), rejected);
		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.submit(form());
		await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
		await swap();
		expect(field().disabled).toBe(true);
		await fireEvent.submit(form());
		expect(transport.login).toHaveBeenCalledTimes(1);
		result.resolve({ success: false });
		await waitFor(() =>
			expect(field().getAttribute("aria-invalid")).toBe("true"),
		);
		await swap();
		expect(field().getAttribute("aria-invalid")).toBe("true");
		await enter(field(), secret());
		expect(field().getAttribute("aria-invalid")).toBe("false");
		await enter(field(), rejected);
		expect(field().getAttribute("aria-invalid")).toBe("true");
	});

	it("associates a held notification with the submitted value rather than a later edit", async () => {
		transport.login.mockReturnValue(new Promise(() => {}));
		render(Layout);
		const submitted = secret();
		await enter(field(), submitted);
		await fireEvent.submit(form());
		await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
		const edited = secret();
		await enter(field(), edited);
		publishNotifications({
			show: [
				{
					name: "auth",
					type: "error",
					msg: "Invalid password",
					is_dismissable: true,
					is_persistent: false,
					duration: 3,
				},
			],
		});
		await tick();
		expect(field().getAttribute("aria-invalid")).toBe("false");
		await swap();
		expect(field().value === edited).toBe(true);
		expect(field().getAttribute("aria-invalid")).toBe("false");
		await enter(field(), submitted);
		expect(field().getAttribute("aria-invalid")).toBe("true");
	});

	it("clears login fields before setup, including a verdict received offline", async () => {
		render(Layout);
		await enter(field(), secret());
		await fireEvent.click(screen.getByRole("checkbox"));
		showOfflinePage();
		await tick();
		publishStatus({ set_password: true });
		await tick();
		hideOfflinePage();
		await tick();
		const password = screen.getByLabelText<HTMLInputElement>(/new password/i);
		const confirmation =
			screen.getByLabelText<HTMLInputElement>(/confirm password/i);
		expect(password.value === "").toBe(true);
		expect(confirmation.value === "").toBe(true);
		await enter(password, secret());
		await enter(confirmation, secret());
		showOfflinePage();
		await tick();
		expect(password.value === "").toBe(true);
		expect(confirmation.value === "").toBe(true);
		hideOfflinePage();
		publishStatus({ set_password: false });
		await tick();
		expect(field().value === "").toBe(true);
		expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it.each([false, true])(
		"scrubs live input synchronously on pagehide persisted=%s and rejects late success",
		async (persisted) => {
			const result = Promise.withResolvers<{
				success: boolean;
				auth_token: string;
			}>();
			transport.login.mockReturnValue(result.promise);
			render(Layout);
			await enter(field(), secret());
			await fireEvent.click(screen.getByRole("checkbox"));
			await fireEvent.submit(form());
			await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
			const input = field();
			window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted }));
			expect(input.value === "").toBe(true);
			result.resolve({ success: true, auth_token: "issued-late-token" });
			await tick();
			expect(getAuthStatus()).toBe(false);
			expect(localStorage.getItem("auth")).toBeNull();
			window.dispatchEvent(
				new PageTransitionEvent("pageshow", { persisted: true }),
			);
			await tick();
			expect(field().value === "").toBe(true);
			expect(field().type).toBe("password");
		},
	);

	it.each(["clear", "logout", "expiry"] as const)(
		"drops the interaction on %s and fences a late result",
		async (boundary) => {
			const result = Promise.withResolvers<{
				success: boolean;
				auth_token: string;
			}>();
			transport.login.mockReturnValue(result.promise);
			render(Layout);
			await enter(field(), secret());
			await fireEvent.submit(form());
			await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
			flushSync(() => {
				switch (boundary) {
					case "clear":
						clearAuthInteraction();
						break;
					case "logout":
						setAuthStatus(false);
						break;
					case "expiry":
						markSessionExpired();
						break;
				}
			});
			expect(field().value === "").toBe(true);
			result.resolve({ success: true, auth_token: "issued-late-token" });
			await tick();
			expect(getAuthStatus()).toBe(false);
			expect(localStorage.getItem("auth")).toBeNull();
		},
	);

	it("clears on canonical success while hidden before a later login", async () => {
		const result = Promise.withResolvers<{ success: boolean }>();
		transport.login.mockReturnValue(result.promise);
		let scrubbedAtPublication: boolean | undefined;
		const unsubscribe = subscribeAuthStatus((status) => {
			if (status && scrubbedAtPublication === undefined) {
				scrubbedAtPublication =
					document.querySelector<HTMLInputElement>("#password")?.value === "";
			}
		});
		try {
			render(Layout);
			await enter(field(), secret());
			await fireEvent.submit(form());
			await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
			const input = field();
			showOfflinePage();
			await tick();
			result.resolve({ success: true });
			await waitFor(() => expect(getAuthStatus()).toBe(true));
			expect(scrubbedAtPublication).toBe(true);
			expect(input.value === "").toBe(true);
			setAuthStatus(false);
			hideOfflinePage();
			await tick();
			expect(field().value === "").toBe(true);
		} finally {
			unsubscribe();
		}
	});

	it("clears the timed-out saved-session interaction before retiring its token", async () => {
		vi.useFakeTimers();
		const result = Promise.withResolvers<{
			success: boolean;
			auth_token: string;
		}>();
		transport.login.mockReturnValue(result.promise);
		localStorage.setItem("auth", "saved-token");
		render(Layout);
		await vi.advanceTimersByTimeAsync(3000);
		await tick();
		await fireEvent.click(screen.getByTestId("clear-saved-session"));
		await tick();
		expect(field().value === "").toBe(true);
		result.resolve({ success: true, auth_token: "late-token" });
		await tick();
		expect(localStorage.getItem("auth")).toBeNull();
		expect(getAuthStatus()).toBe(false);
	});

	it.each([false, true])(
		"scrubs setup fields on device completion success=%s",
		async (success) => {
			const created = Promise.withResolvers<{ success: boolean }>();
			const signedIn = Promise.withResolvers<{ success: boolean }>();
			transport.setPassword.mockReturnValue(created.promise);
			transport.login.mockReturnValue(signedIn.promise);
			publishStatus({ set_password: true });
			render(Layout);
			const password = screen.getByLabelText<HTMLInputElement>(/new password/i);
			const confirmation =
				screen.getByLabelText<HTMLInputElement>(/confirm password/i);
			const value = secret();
			await enter(password, value);
			await enter(confirmation, value);
			await fireEvent.submit(form());
			await waitFor(() =>
				expect(transport.setPassword).toHaveBeenCalledTimes(1),
			);
			expect(transport.login.mock.calls.length).toBe(0);
			created.resolve({ success });
			await waitFor(() => expect(password.value === "").toBe(true));
			expect(confirmation.value === "").toBe(true);
			if (success) {
				await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
				signedIn.resolve({ success: true });
				await waitFor(() => expect(getAuthStatus()).toBe(true));
			} else {
				expect(transport.login.mock.calls.length).toBe(0);
				expect(getAuthStatus()).toBe(false);
			}
		},
	);

	it("invalidates pending login before a reset-to-setup verdict received offline", async () => {
		const result = Promise.withResolvers<{
			success: boolean;
			auth_token: string;
		}>();
		transport.login.mockReturnValue(result.promise);
		render(Layout);
		await enter(field(), secret());
		await fireEvent.submit(form());
		await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
		showOfflinePage();
		publishStatus({ set_password: true });
		await tick();
		result.resolve({ success: true, auth_token: "retired-login-token" });
		hideOfflinePage();
		await tick();
		expect(
			screen.getByLabelText<HTMLInputElement>(/new password/i).value === "",
		).toBe(true);
		expect(
			screen.getByLabelText<HTMLInputElement>(/confirm password/i).value === "",
		).toBe(true);
		expect(getAuthStatus()).toBe(false);
		expect(localStorage.getItem("auth")).toBeNull();
	});

	it("keeps native input bytes and refuses composing Enter without submitting", async () => {
		transport.login.mockResolvedValue({ success: false });
		render(Layout);
		const value = secret();
		await fireEvent.input(field(), {
			target: { value },
			inputType: "insertFromPaste",
		});
		await fireEvent.compositionStart(field());
		expect(
			await fireEvent.keyDown(field(), { key: "Enter", isComposing: true }),
		).toBe(false);
		await fireEvent.submit(form());
		expect(transport.login.mock.calls.length).toBe(0);
		await fireEvent.compositionEnd(field());
		expect(field().value === value).toBe(true);
		await fireEvent.submit(form());
		await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
		expect(transport.login.mock.calls[0]?.[0]?.password === value).toBe(true);
	});

	it("retires a sent attempt on real owner teardown", async () => {
		const result = Promise.withResolvers<{
			success: boolean;
			auth_token: string;
		}>();
		transport.login.mockReturnValue(result.promise);
		const owner = render(Layout);
		await enter(field(), secret());
		await fireEvent.submit(form());
		await waitFor(() => expect(transport.login).toHaveBeenCalledTimes(1));
		const input = field();
		owner.unmount();
		expect(input.value === "").toBe(true);
		result.resolve({ success: true, auth_token: "late-owner-token" });
		await tick();
		expect(getAuthStatus()).toBe(false);
		expect(localStorage.getItem("auth")).toBeNull();
	});

	it("starts a BFCache restoration blank even if pagehide was not observed", async () => {
		render(Layout);
		await enter(field(), secret());
		await fireEvent.click(screen.getByTestId("auth-password-visibility"));
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
		expect(field().value === "").toBe(true);
		expect(field().type).toBe("password");
	});
});
