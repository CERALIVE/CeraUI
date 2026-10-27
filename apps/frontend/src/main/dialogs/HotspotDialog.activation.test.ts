// @vitest-environment jsdom
/**
 * #413: enabling a hotspot can drop the Wi-Fi link the operator is using, so the
 * dialog never starts one before the exact credentials have been shown and
 * acknowledged. Asserted against the rendered DOM and the RPCs actually sent.
 */
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import HotspotDialog from "./HotspotDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotStart: vi.fn(async () => ({ success: true, accepted: true })),
			hotspotStop: vi.fn(),
			hotspotPrepare: vi.fn(),
			hotspotConfigure: vi.fn(async () => ({ success: true })),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));

const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const start = vi.mocked(rpc.wifi.hotspotStart);

// A station-mode radio: the wire carries NO hotspot block, so the dialog has
// never been told any credentials — the exact #413 starting point.
const STATION: WifiInterface = {
	ifname: "wlan0",
	conn: "HomeNet",
	hw: "58:02:05:e1:79:1c",
	saved: {},
	supports_hotspot: true,
} as WifiInterface;

function q<T extends HTMLElement = HTMLElement>(testid: string): T | null {
	return document.querySelector<T>(`[data-testid="${testid}"]`);
}

function enableButton(): HTMLButtonElement {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
	].find((b) => b.textContent?.includes("Enable Hotspot"));
	if (!button) throw new Error("no Enable Hotspot button");
	return button;
}

async function openGate(): Promise<HTMLElement> {
	render(HotspotDialog, {
		props: { open: true, deviceId: "0", iface: STATION },
	});
	await fireEvent.click(enableButton());
	return vi.waitFor(() => {
		const gate = q("hotspot-activation-confirm");
		if (
			gate?.dataset.phase !== "ready" &&
			gate?.dataset.phase !== "load-failed"
		) {
			throw new Error("gate not settled");
		}
		return gate;
	});
}

async function acknowledge(): Promise<void> {
	const ack = q("hotspot-activation-confirm")?.querySelector<HTMLElement>(
		'[role="checkbox"]',
	);
	if (!ack) throw new Error("no acknowledgement");
	await fireEvent.click(ack);
	await tick();
}

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
});

beforeEach(() => {
	initAsyncOperations();
	prepare.mockResolvedValue({
		success: true,
		name: "CERALIVE_791c",
		password: "Xk7mQ2pR9tLw",
	});
});

afterEach(() => {
	destroyAsyncOperations();
	vi.clearAllMocks();
});

describe("HotspotDialog — no hotspot starts unseen (#413)", () => {
	it("renders no editable form while off, so nothing typed can be silently ignored", () => {
		render(HotspotDialog, {
			props: { open: true, deviceId: "0", iface: STATION },
		});
		expect(document.querySelector("#hotspot-name")).toBeNull();
		expect(document.querySelector("#hotspot-password")).toBeNull();
		expect(q("hotspot-inactive-hint")).not.toBeNull();
		const save = [
			...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
		].find((b) => b.textContent?.includes("Save"));
		// Save only reconfigures a live AP, so it is not offered while off.
		expect(save).toBeUndefined();
	});

	it("Enable opens the gate with the REAL credentials visible and starts nothing", async () => {
		await openGate();

		expect(start).not.toHaveBeenCalled();
		expect(prepare).toHaveBeenCalledWith({ device: "0" });
		const password = q<HTMLInputElement>("hotspot-confirm-password");
		expect(q<HTMLInputElement>("hotspot-confirm-name")?.value).toBe(
			"CERALIVE_791c",
		);
		expect(password?.value).toBe("Xk7mQ2pR9tLw");
		expect(password?.type).toBe("text");
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			true,
		);
	});

	it("starts exactly once, only after the acknowledgement, without re-saving unchanged credentials", async () => {
		await openGate();
		await acknowledge();
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			false,
		);

		await fireEvent.click(q("hotspot-confirm-activate") as HTMLElement);
		await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		expect(start).toHaveBeenCalledWith({ device: "0" });
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(q("hotspot-activation-confirm")).toBeNull();
	});

	it("an operator's own password is stored BEFORE the start, and editing clears the acknowledgement", async () => {
		await openGate();
		await acknowledge();
		const input = q<HTMLInputElement>(
			"hotspot-confirm-password",
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "my own pass" } });
		await tick();
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			true,
		);

		prepare.mockResolvedValueOnce({
			success: true,
			name: "CERALIVE_791c",
			password: "my own pass",
		});
		await acknowledge();
		await fireEvent.click(q("hotspot-confirm-activate") as HTMLElement);

		await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		expect(prepare).toHaveBeenLastCalledWith({
			device: "0",
			name: "CERALIVE_791c",
			password: "my own pass",
		});
		expect(prepare.mock.invocationCallOrder.at(-1)).toBeLessThan(
			start.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("a new random password replaces the shown one and needs a fresh acknowledgement", async () => {
		await openGate();
		await acknowledge();
		await fireEvent.click(q("hotspot-confirm-generate") as HTMLElement);
		await tick();

		const rolled = q<HTMLInputElement>("hotspot-confirm-password")?.value ?? "";
		expect(rolled).not.toBe("Xk7mQ2pR9tLw");
		expect(rolled).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/);
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			true,
		);
	});

	it("a password that WPA cannot carry blocks the start", async () => {
		await openGate();
		const input = q<HTMLInputElement>(
			"hotspot-confirm-password",
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "contraseña123" } });
		await acknowledge();
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			true,
		);
	});

	it("fails CLOSED when the credentials cannot be read", async () => {
		prepare.mockRejectedValueOnce(new Error("socket closed"));
		await openGate();

		expect(q("hotspot-confirm-load-failed")).not.toBeNull();
		expect(q<HTMLButtonElement>("hotspot-confirm-activate")?.disabled).toBe(
			true,
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("never starts when the device did not store the chosen credentials", async () => {
		await openGate();
		const input = q<HTMLInputElement>(
			"hotspot-confirm-password",
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "my own pass" } });
		prepare.mockResolvedValueOnce({
			success: false,
			error: "activation-failed",
		});
		await acknowledge();
		await fireEvent.click(q("hotspot-confirm-activate") as HTMLElement);

		await vi.waitFor(() =>
			expect(q("hotspot-confirm-save-failed")).not.toBeNull(),
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("reads as a first-time setup only when the device says it has never hosted", async () => {
		prepare.mockResolvedValueOnce({
			success: true,
			name: "CERALIVE_791c",
			password: "Xk7mQ2pR9tLw",
			firstTime: true,
		});
		await openGate();
		expect(q("hotspot-confirm-first-time")).not.toBeNull();
		expect(q("hotspot-activation-confirm")?.textContent).toContain(
			"Set up your hotspot",
		);
	});

	it("a saved setup is offered as-is, without the first-time framing", async () => {
		await openGate();
		expect(q("hotspot-confirm-first-time")).toBeNull();
	});

	it("fills the edit form from the live AP once it comes up", async () => {
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "0", iface: STATION },
		});
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: {
				...STATION,
				conn: "hotspot-uuid",
				mode: "hotspot",
				hotspot: {
					name: "CERALIVE_791c",
					password: "Xk7mQ2pR9tLw",
					available_channels: { auto: { name: "Automatic" } },
					channel: "auto",
				},
			} as WifiInterface,
		});
		await tick();
		expect(
			document.querySelector<HTMLInputElement>("#hotspot-name")?.value,
		).toBe("CERALIVE_791c");
		expect(
			document.querySelector<HTMLInputElement>("#hotspot-password")?.value,
		).toBe("Xk7mQ2pR9tLw");
	});

	it("Cancel closes the gate and starts nothing", async () => {
		await openGate();
		await fireEvent.click(q("hotspot-confirm-cancel") as HTMLElement);
		await tick();
		expect(q("hotspot-activation-confirm")).toBeNull();
		expect(start).not.toHaveBeenCalled();
	});
});
