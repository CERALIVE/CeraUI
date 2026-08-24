// @vitest-environment jsdom
/**
 * NetifDialog — a REFUSED save is named, not swallowed (todo 15, regression).
 *
 * This is a regression test against the RETIRED always-success shape, and the
 * defect it pins had two layers:
 *
 *   1. Before todo 8, `configureNetworkInterfaceProcedure` answered
 *      `{success:true}` however `handleNetif` went — so a save the device's
 *      `int.ip !== msg.ip` concurrency guard DISCARDED WHOLE (the bond toggle
 *      riding alongside it included) reached the operator as "Saved", and the
 *      dialog closed over it. Board-proven: bonding toggled off, "Saved" toasted,
 *      the row still read "In Bond".
 *   2. Todo 8 made the procedure answer `{success:false, error}` with FOUR typed
 *      reasons — and this dialog rendered all four as ONE generic toast that
 *      names nothing and then expires. `stale_address` (re-read and retry),
 *      `disable_all_refused` (add a link first) and `enable_refused` (read the
 *      row's own reason) are three different operator actions.
 *
 * Both layers are closed by the same standing band: the typed reason renders
 * inline, beside the Save it answers, and stays there. A thrown rpc keeps the
 * toast — a transport fault names no reason worth standing.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { setEthernetRole: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: () => false,
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "svelte-sonner";

import { rpc } from "$lib/rpc";
import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";

import NetifDialog from "./NetifDialog.svelte";

const configure = vi.mocked(rpc.network.configure);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { tp: 0, enabled: true, ip: "192.168.0.169", ...overrides };
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetifDialog — the stale-address refusal is rendered honestly", () => {
	it("names the reason inline and NEVER reports the discarded save as saved", async () => {
		configure.mockResolvedValueOnce({
			success: false,
			error: "stale_address",
		});

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		// The operator's edit — the exact payload the retired guard discarded whole.
		await fireEvent.click(screen.getByRole("switch"));
		await fireEvent.click(saveButton());

		const band = await screen.findByTestId("netif-save-error");
		expect(band.getAttribute("data-error")).toBe("stale_address");
		expect(band.textContent).toContain(
			"address changed while the dialog was open",
		);

		// The retired shape's two symptoms, both refused.
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(saveButton()).toBeTruthy();
		// …and the operator's choice survives the refusal.
		expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it("keeps a structured refusal OFF the toast path", async () => {
		// One fact announced twice reads as two failures — and the toast expires
		// while the band, which is the one that names the reason, does not.
		configure.mockResolvedValueOnce({
			success: false,
			error: "stale_address",
		});

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});
		await fireEvent.click(saveButton());

		await screen.findByTestId("netif-save-error");
		expect(toastError).not.toHaveBeenCalled();
	});

	it.each([
		["unknown_interface", "could not find this interface"],
		["stale_address", "address changed while the dialog was open"],
		["enable_refused", "refused to add this interface to the bond"],
		["disable_all_refused", "last link in the bond"],
	])("gives %s its own sentence", async (error, fragment) => {
		configure.mockResolvedValueOnce({ success: false, error });

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});
		await fireEvent.click(saveButton());

		const band = await screen.findByTestId("netif-save-error");
		expect(band.getAttribute("data-error")).toBe(error);
		expect(band.textContent).toContain(fragment);
		// A machine token never reaches the operator.
		expect(band.textContent).not.toContain(error);
	});

	it("falls back to the generic sentence for a refusal carrying no reason", async () => {
		configure.mockResolvedValueOnce({ success: false });

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});
		await fireEvent.click(saveButton());

		const band = await screen.findByTestId("netif-save-error");
		expect(band.getAttribute("data-error")).toBe("unknown");
		expect(band.textContent).toContain("nothing was saved");
	});

	it("a THROWN rpc keeps the toast and raises NO band — it names no reason", async () => {
		configure.mockRejectedValueOnce(new Error("socket dropped"));

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});
		await fireEvent.click(saveButton());

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("netif-save-error")).toBeNull();
		expect(saveButton()).toBeTruthy();
	});

	it("a SUCCESS raises no band and closes the dialog", async () => {
		configure.mockResolvedValueOnce({
			success: true,
			applied: { name: "eth0", enabled: true },
		});

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});
		await fireEvent.click(saveButton());

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("netif-save-error")).toBeNull();
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
		);
	});

	it("a retry clears the previous band before it dispatches", async () => {
		configure
			.mockResolvedValueOnce({ success: false, error: "stale_address" })
			.mockResolvedValueOnce({
				success: true,
				applied: { name: "eth0", enabled: true },
			});

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		await fireEvent.click(saveButton());
		await screen.findByTestId("netif-save-error");

		await fireEvent.click(saveButton());
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(screen.queryByTestId("netif-save-error")).toBeNull(),
		);
	});
});
