// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { Toaster, toast } from "svelte-sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	getAuthStatus,
	setAuthStatus,
} from "../../lib/stores/auth-status.svelte";
import PasswordDialog from "./PasswordDialog.svelte";

const transport = vi.hoisted(() => ({
	setPassword: vi.fn(),
	login: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: {
			setPassword: (input: unknown) =>
				transport.setPassword(structuredClone(input)),
			login: (input: unknown) => transport.login(structuredClone(input)),
		},
	},
	rpcClient: {
		isConnected: () => true,
		getConnectionState: () => "connected",
		onConnectionChange: () => () => undefined,
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
	getNotifications: () => undefined,
}));

function field(id: string): HTMLInputElement {
	const input = document.getElementById(id);
	if (!(input instanceof HTMLInputElement))
		throw new Error("Password field missing");
	return input;
}

beforeEach(() => {
	transport.setPassword.mockReset();
	transport.login.mockReset();
	toast.dismiss();
	setAuthStatus(true);
	localStorage.setItem("auth", "previous-issued-token");
});
afterEach(() => {
	toast.dismiss();
	vi.restoreAllMocks();
	setAuthStatus(false);
});

it("keeps rejected settings changes visible and only closes after a confirmed retry", async () => {
	const rejected = Promise.withResolvers<{ success: boolean }>();
	transport.setPassword.mockReturnValueOnce(rejected.promise);
	transport.setPassword.mockResolvedValueOnce({ success: true });
	const successToast = vi.spyOn(toast, "success");
	render(Toaster);
	const dialog = render(PasswordDialog, { open: true });
	await screen.findByRole("dialog");
	const draft = crypto.randomUUID();
	await fireEvent.input(field("device-password"), { target: { value: draft } });
	await fireEvent.input(field("device-password-confirm"), {
		target: { value: draft },
	});
	const save = screen.getByRole("button", { name: m["advanced.save"]() });

	await fireEvent.click(save);
	await waitFor(() => expect(transport.setPassword).toHaveBeenCalledTimes(1));
	expect(save.hasAttribute("disabled")).toBe(true);
	rejected.resolve({ success: false });

	await screen.findByText(m["advanced.copyFailed"]());
	expect(screen.queryByRole("dialog")).not.toBeNull();
	expect(successToast.mock.calls.length).toBe(0);
	expect(field("device-password").value === draft).toBe(true);
	expect(field("device-password-confirm").value === draft).toBe(true);
	expect(localStorage.getItem("auth")).toBe("previous-issued-token");
	expect(getAuthStatus()).toBe(true);
	expect(transport.login.mock.calls.length).toBe(0);
	await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));

	await fireEvent.click(save);
	await waitFor(() => expect(successToast).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(localStorage.getItem("auth")).toBeNull();
	await dialog.rerender({ open: false });
	await dialog.rerender({ open: true });
	await screen.findByRole("dialog");
	expect(field("device-password").value === "").toBe(true);
	expect(field("device-password-confirm").value === "").toBe(true);
});
