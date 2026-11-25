// @vitest-environment jsdom
/**
 * WifiNetworkList: the row is the Connect control, and Forget lives in the
 * network's details, away from it.
 *
 * On a phone a row used to end in a small plug icon with a trash icon right
 * beside it, so a slightly missed tap on Connect could land on Forget, and
 * both targets were under the 44 px minimum (`DESIGN.md` §6). Now a tap on the
 * row joins (or opens the password prompt), and a saved network's Forget,
 * Change password and Disconnect sit in its details panel.
 */
import type { AvailableWifiNetwork, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import WifiNetworkList from "./WifiNetworkList.svelte";

const net = (
	ssid: string,
	over: Partial<AvailableWifiNetwork> = {},
): AvailableWifiNetwork => ({
	active: false,
	ssid,
	signal: 72,
	security: "WPA2",
	freq: 5180,
	...over,
});

const ACTIVE = net("HomeNetwork", { active: true, signal: 92 });
const SAVED = net("Cafe-Guest");
const NEW_SECURED = net("Neighbour-5G");
const NEW_OPEN = net("Library-Free", {
	security: "",
	bssid: "02:00:00:00:51:01",
});

function iface(
	networks: AvailableWifiNetwork[],
	over: Partial<WifiInterface> = {},
): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "uuid-home",
		hw: "",
		saved: { HomeNetwork: "uuid-home", "Cafe-Guest": "uuid-cafe" },
		saved_key_mgmt: { "uuid-home": "wpa-psk", "uuid-cafe": "wpa-psk" },
		available: networks,
		...over,
	};
}

function setup(
	networks: AvailableWifiNetwork[],
	over: Record<string, unknown> = {},
	ifaceOver: Partial<WifiInterface> = {},
) {
	const handlers = {
		onScan: vi.fn(),
		onConnectSaved: vi.fn(),
		onDisconnect: vi.fn(),
		onConnectNew: vi.fn(),
		onForget: vi.fn(),
		onConfirmForget: vi.fn(),
		onSubmitNew: vi.fn(),
		onResetInteraction: vi.fn(),
	};
	const result = render(WifiNetworkList, {
		props: {
			iface: iface(networks, ifaceOver),
			networks,
			ifaceBusy: false,
			scanning: false,
			deviceId: "0",
			connecting: undefined,
			disconnecting: undefined,
			forgetting: undefined,
			pendingNew: undefined,
			confirmForget: undefined,
			passwordMin: 8,
			password: "",
			showPassword: false,
			...handlers,
			...over,
		},
	});
	return { ...result, handlers };
}

const button = (name: string) =>
	screen.getByRole("button", { name }) as HTMLButtonElement;
const noButton = (name: string) => screen.queryByRole("button", { name });

describe("a tap on the row joins", () => {
	it("connects a saved network from its row", async () => {
		const { handlers } = setup([SAVED]);
		const row = button(`Connect ${SAVED.ssid}`);
		// The row carries the network's name, so the whole row is the target.
		expect(row.textContent).toContain(SAVED.ssid);
		await fireEvent.click(row);
		expect(handlers.onConnectSaved).toHaveBeenCalledWith("uuid-cafe", SAVED);
	});

	it("opens the password prompt for a new secured network", async () => {
		const { handlers } = setup([NEW_SECURED]);
		const row = button(`Connect ${NEW_SECURED.ssid}`);
		expect(row.textContent).toContain(NEW_SECURED.ssid);
		await fireEvent.click(row);
		expect(handlers.onConnectNew).toHaveBeenCalledWith(NEW_SECURED);
	});

	it("joins a new open network from its row", async () => {
		const { handlers } = setup([NEW_OPEN]);
		const row = button(`Connect ${NEW_OPEN.ssid}`);
		expect(row.textContent).toContain(NEW_OPEN.ssid);
		await fireEvent.click(row);
		expect(handlers.onConnectNew).toHaveBeenCalledWith(NEW_OPEN);
	});

	it("closes the password prompt on a second tap", async () => {
		const { handlers } = setup([NEW_SECURED], { pendingNew: NEW_SECURED });
		await fireEvent.click(button(`Connect ${NEW_SECURED.ssid}`));
		expect(handlers.onResetInteraction).toHaveBeenCalledTimes(1);
		expect(handlers.onConnectNew).not.toHaveBeenCalled();
	});

	it("still joins a saved network whose Change password form is open", async () => {
		const { handlers } = setup([SAVED], { pendingNew: SAVED });
		await fireEvent.click(button(`Connect ${SAVED.ssid}`));
		expect(handlers.onConnectSaved).toHaveBeenCalledWith("uuid-cafe", SAVED);
		expect(handlers.onResetInteraction).not.toHaveBeenCalled();
	});

	it("tells assistive tech whether the password prompt is open", () => {
		setup([NEW_SECURED], { pendingNew: NEW_SECURED });
		expect(
			button(`Connect ${NEW_SECURED.ssid}`).getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("describes the row's security and saved status", () => {
		setup([SAVED, NEW_OPEN]);
		const describe = (name: string) =>
			(button(name).getAttribute("aria-describedby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent ?? "")
				.join(" ");
		expect(describe(`Connect ${SAVED.ssid}`)).toContain("Secured network");
		expect(describe(`Connect ${SAVED.ssid}`)).toContain("Saved");
		expect(describe(`Connect ${NEW_OPEN.ssid}`)).toContain("Open network");
	});

	it("disables the row while the adapter is busy", () => {
		setup([SAVED], { ifaceBusy: true });
		expect(button(`Connect ${SAVED.ssid}`).disabled).toBe(true);
	});
});

describe("Forget is in the network's details, not next to Connect", () => {
	it("shows no Forget, Change password or Disconnect on the row itself", () => {
		setup([ACTIVE, SAVED, NEW_SECURED]);
		for (const ssid of [ACTIVE.ssid, SAVED.ssid, NEW_SECURED.ssid]) {
			expect(noButton(`Forget ${ssid}`)).toBeNull();
			expect(noButton(`Change password ${ssid}`)).toBeNull();
			expect(noButton(`Disconnect ${ssid}`)).toBeNull();
		}
	});

	it("opens a saved network's details with Change password and Forget", async () => {
		setup([SAVED]);
		const manage = button(`Manage ${SAVED.ssid}`);
		expect(manage.getAttribute("aria-expanded")).toBe("false");
		await fireEvent.click(manage);
		expect(manage.getAttribute("aria-expanded")).toBe("true");

		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).getByRole("button", {
				name: `Change password ${SAVED.ssid}`,
			}),
		).toBeTruthy();
		expect(
			within(panel).getByRole("button", { name: `Forget ${SAVED.ssid}` }),
		).toBeTruthy();
		// Connect stays the row; the panel never repeats it next to Forget.
		expect(
			within(panel).queryByRole("button", { name: `Connect ${SAVED.ssid}` }),
		).toBeNull();
	});

	it("asks before forgetting", async () => {
		const { handlers } = setup([SAVED]);
		await fireEvent.click(button(`Manage ${SAVED.ssid}`));
		await fireEvent.click(button(`Forget ${SAVED.ssid}`));
		expect(handlers.onConfirmForget).toHaveBeenCalledWith(SAVED.ssid);
		expect(handlers.onForget).not.toHaveBeenCalled();
	});

	it("keeps the confirm step inside the details, with nothing else beside it", async () => {
		const { handlers, rerender } = setup([SAVED]);
		await fireEvent.click(button(`Manage ${SAVED.ssid}`));
		await fireEvent.click(button(`Forget ${SAVED.ssid}`));
		// The dialog owns the confirmation; it answers by passing the SSID back.
		await rerender({ confirmForget: SAVED.ssid });
		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).queryByRole("button", { name: /^Change password / }),
		).toBeNull();
		await fireEvent.click(
			within(panel).getByRole("button", { name: "Forget" }),
		);
		expect(handlers.onForget).toHaveBeenCalledWith("uuid-cafe", SAVED);
	});

	it("puts Close where the asking Forget was and the destructive Forget at the far end", async () => {
		const { rerender } = setup([SAVED]);
		await fireEvent.click(button(`Manage ${SAVED.ssid}`));
		const asking = button(`Forget ${SAVED.ssid}`);
		const slot = asking.parentElement;
		const index = Array.from(slot?.children ?? []).indexOf(asking);
		await fireEvent.click(asking);
		await rerender({ confirmForget: SAVED.ssid });
		// A repeated tap on the same spot lands on Close, not on the destructive Forget.
		expect(slot?.children[index]).toBe(
			screen.getByTestId("wifi-forget-cancel"),
		);
		const confirm = screen.getByTestId("wifi-forget-confirm");
		expect(confirm.parentElement).toBe(slot);
		expect(slot?.lastElementChild).toBe(confirm);
		expect(confirm.className).toContain("ms-auto");
	});

	it("shows no Disconnect while the connected network's Forget is being confirmed", async () => {
		const { rerender } = setup([ACTIVE]);
		await fireEvent.click(button(`Manage ${ACTIVE.ssid}`));
		await fireEvent.click(button(`Forget ${ACTIVE.ssid}`));
		await rerender({ confirmForget: ACTIVE.ssid });
		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).queryByRole("button", { name: /^Disconnect / }),
		).toBeNull();
		expect(within(panel).getByRole("button", { name: "Forget" })).toBeTruthy();
	});

	it("drops the confirmation when the network's profile is replaced", async () => {
		const { handlers, rerender } = setup([SAVED]);
		await fireEvent.click(button(`Manage ${SAVED.ssid}`));
		await fireEvent.click(button(`Forget ${SAVED.ssid}`));
		await rerender({ confirmForget: SAVED.ssid });
		expect(button("Forget")).toBeTruthy();

		// A new profile now sits under the same SSID.
		await rerender({
			iface: iface([SAVED], {
				saved: { HomeNetwork: "uuid-home", [SAVED.ssid]: "uuid-cafe-2" },
				saved_key_mgmt: { "uuid-home": "wpa-psk", "uuid-cafe-2": "wpa-psk" },
			}),
		});
		expect(noButton("Forget")).toBeNull();
		expect(handlers.onForget).not.toHaveBeenCalled();
	});

	it("does not confirm a Forget the list did not ask for", () => {
		setup([SAVED], { confirmForget: SAVED.ssid });
		expect(noButton("Forget")).toBeNull();
	});

	it("opens the connected network's details from its row, with Disconnect", async () => {
		const { handlers } = setup([ACTIVE]);
		const row = button(`Manage ${ACTIVE.ssid}`);
		expect(row.textContent).toContain(ACTIVE.ssid);
		await fireEvent.click(row);
		const panel = screen.getByTestId("wifi-network-details");
		await fireEvent.click(
			within(panel).getByRole("button", { name: `Disconnect ${ACTIVE.ssid}` }),
		);
		expect(handlers.onDisconnect).toHaveBeenCalledWith("uuid-home", ACTIVE);
		expect(handlers.onConnectSaved).not.toHaveBeenCalled();
	});

	it("never offers a password change for the connected network", async () => {
		setup([ACTIVE]);
		await fireEvent.click(button(`Manage ${ACTIVE.ssid}`));
		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).queryByRole("button", { name: /^Change password / }),
		).toBeNull();
	});

	it("offers no details for a network that is not saved", () => {
		setup([NEW_SECURED]);
		expect(noButton(`Manage ${NEW_SECURED.ssid}`)).toBeNull();
	});
});

describe("only the network this radio is on through its own profile opens details from the row", () => {
	// One scan, active flags included, reaches every radio while each radio keeps
	// its own saved map and connection. A network another radio is on arrives
	// here active, so the active flag alone must not turn the row into a
	// details control: the row keeps joining on this radio.
	const ELSEWHERE = net("Office-WPA2", { active: true, signal: 80 });

	it("joins an active network this radio has no profile for", async () => {
		const { handlers } = setup([ELSEWHERE]);
		const row = button(`Connect ${ELSEWHERE.ssid}`);
		expect(row.disabled).toBe(false);
		// Its disclosure is the password prompt (closed), not a details panel.
		expect(row.getAttribute("aria-expanded")).toBe("false");
		await fireEvent.click(row);
		expect(handlers.onConnectNew).toHaveBeenCalledWith(ELSEWHERE);
		expect(noButton(`Manage ${ELSEWHERE.ssid}`)).toBeNull();
		expect(screen.queryByTestId("wifi-network-details")).toBeNull();
	});

	it("joins an active network this radio has saved but is not on", async () => {
		const { handlers } = setup(
			[ELSEWHERE],
			{},
			{
				conn: "uuid-home",
				saved: { HomeNetwork: "uuid-home", [ELSEWHERE.ssid]: "uuid-office" },
				saved_key_mgmt: { "uuid-home": "wpa-psk", "uuid-office": "wpa-psk" },
			},
		);
		await fireEvent.click(button(`Connect ${ELSEWHERE.ssid}`));
		expect(handlers.onConnectSaved).toHaveBeenCalledWith(
			"uuid-office",
			ELSEWHERE,
		);
		// Its profile is still managed from the separate control, with no Disconnect.
		await fireEvent.click(button(`Manage ${ELSEWHERE.ssid}`));
		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).getByRole("button", { name: `Forget ${ELSEWHERE.ssid}` }),
		).toBeTruthy();
		expect(
			within(panel).queryByRole("button", { name: /^Disconnect / }),
		).toBeNull();
	});

	it("stays disabled while the adapter is busy, like any other join", () => {
		setup([ELSEWHERE], { ifaceBusy: true });
		expect(button(`Connect ${ELSEWHERE.ssid}`).disabled).toBe(true);
	});
});
