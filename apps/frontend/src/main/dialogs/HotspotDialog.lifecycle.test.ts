// @vitest-environment jsdom
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import {
	noteLinkState,
	noteSessionRestored,
} from "$lib/rpc/session-epoch.svelte";
import HotspotDialog from "./HotspotDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(async () => ({ success: true, accepted: true })),
			getAdapterModes: vi.fn(async () => ({})),
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

const RADIO_A: WifiInterface = {
	ifname: "wlan0",
	conn: "HomeNet",
	hw: "58:02:05:e1:79:1c",
	saved: {},
	supports_hotspot: true,
};
const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const start = vi.mocked(rpc.wifi.hotspotStart);

function value(testId: string): string | undefined {
	return document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
		?.value;
}

beforeEach(() => {
	noteLinkState("connected");
	initAsyncOperations();
	prepare.mockResolvedValue({
		success: true,
		name: "Radio-A",
		password: "radio-a-password",
	});
});

afterEach(() => {
	noteLinkState("disconnected");
	destroyAsyncOperations();
	vi.clearAllMocks();
});

it.each(["ready", "saving"] as const)(
	"withdraws %s credentials when a restarted backend reuses the radio key",
	async (phase) => {
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "0", iface: RADIO_A },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Enable Hotspot" }),
		);
		await vi.waitFor(() =>
			expect(value("hotspot-confirm-name")).toBe("Radio-A"),
		);
		await fireEvent.click(screen.getByRole("checkbox"));
		expect(
			document.querySelector<HTMLButtonElement>(
				'[data-testid="hotspot-confirm-activate"]',
			)?.disabled,
		).toBe(false);

		let finishSave: (() => void) | undefined;
		if (phase === "saving") {
			await fireEvent.input(screen.getByTestId("hotspot-confirm-password"), {
				target: { value: "edited-radio-a-password" },
			});
			await fireEvent.click(screen.getByRole("checkbox"));
			prepare.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishSave = () =>
							resolve({
								success: true,
								name: "Radio-A",
								password: "edited-radio-a-password",
							});
					}),
			);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		}

		try {
			noteLinkState("disconnected");
			await tick();
			expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
			expect(start).not.toHaveBeenCalled();

			// The restored roster replaces A directly: no empty intermediate map.
			prepare.mockResolvedValue({
				success: true,
				name: "Radio-B",
				password: "radio-b-password",
			});
			await view.rerender({
				open: true,
				deviceId: "0",
				iface: { ...RADIO_A, hw: "58:02:05:e1:79:2d", ifname: "wlan1" },
			});
			noteLinkState("connected");
			noteSessionRestored();
			await tick();
			await fireEvent.click(
				screen.getByRole("button", { name: "Enable Hotspot" }),
			);
			await vi.waitFor(() =>
				expect(value("hotspot-confirm-name")).toBe("Radio-B"),
			);
			expect(value("hotspot-confirm-password")).toBe("radio-b-password");
			expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
				"false",
			);
			expect(
				document.querySelector<HTMLButtonElement>(
					'[data-testid="hotspot-confirm-activate"]',
				)?.disabled,
			).toBe(true);

			finishSave?.();
			await tick();
			expect(start).not.toHaveBeenCalled();
			expect(value("hotspot-confirm-name")).toBe("Radio-B");
		} finally {
			finishSave?.();
			await tick();
		}
	},
);
