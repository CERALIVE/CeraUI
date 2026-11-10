// @vitest-environment jsdom
import type { WifiInterface } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
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
	beginOperation,
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import WifiModeSelector from "$main/network/WifiModeSelector.svelte";
import { deriveWifiAdapterModeView } from "$main/network/wifi-adapter-mode-view";
import {
	wifiHotspotConfigOpKey,
	wifiHotspotOpKey,
	wifiModeOpKey,
} from "$main/network/wifi-station-lock";
import HotspotDialog from "./HotspotDialog.svelte";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(),
		},
	},
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const start = vi.mocked(rpc.wifi.hotspotStart);
const configure = vi.mocked(rpc.wifi.hotspotConfigure);
const mode = vi.mocked(rpc.wifi.setAdapterMode);

function row(
	incarnation: string | undefined = "radio-A",
	active = false,
): WifiInterface {
	return {
		ifname: "wlan0",
		hw: "same-model",
		conn: active ? "ap-uuid" : "Home",
		saved: {},
		supports_hotspot: true,
		supports_ap_sta_concurrency: true,
		...(incarnation === undefined ? {} : { incarnation }),
		...(active
			? {
					mode: "hotspot",
					hotspot: {
						name: `${incarnation}-stored`,
						password: "stored-password",
						channel: "auto",
						available_channels: {
							auto: { name: "Automatic" },
							ch_6: { name: "Channel 6" },
						},
						security: "wpa2",
						available_security: {
							wpa2: { name: "WPA2" },
							"wpa3-sae": { name: "WPA3" },
						},
					},
				}
			: {}),
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function input(id: string): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(
		`#${id}, [data-testid="${id}"]`,
	);
	if (!element) throw new Error(`Missing input ${id}`);
	return element;
}

async function gate() {
	await fireEvent.click(screen.getByRole("button", { name: "Enable Hotspot" }));
	await ready();
}

async function ready() {
	await waitFor(() =>
		expect(screen.getByTestId("hotspot-activation-confirm").dataset.phase).toBe(
			"ready",
		),
	);
}

async function editAndAcknowledge() {
	await fireEvent.input(input("hotspot-confirm-name"), {
		target: { value: "typed-name" },
	});
	await fireEvent.input(input("hotspot-confirm-password"), {
		target: { value: "typed-password" },
	});
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
}

beforeAll(() => {
	window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});
beforeEach(() => {
	vi.resetAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("connected");
	prepare.mockImplementation(async (request) => ({
		success: true,
		name: request.name ?? `${request.incarnation}-stored`,
		password: request.password ?? "stored-password",
	}));
	start.mockResolvedValue({ success: true });
	configure.mockResolvedValue({ success: true });
	vi.mocked(rpc.wifi.hotspotStop).mockResolvedValue({
		success: true,
	});
	mode.mockResolvedValue({ success: true, accepted: true });
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
});

describe("hotspot draft ownership through the real dialog", () => {
	for (const patch of [
		{ ifname: "renamed0" },
		{ scanGeneration: 9 },
		{
			available: [
				{ active: true, ssid: "Home", signal: 8, security: "WPA2", freq: 2412 },
			],
		},
	]) {
		it(`preserves the typed gate pair and acknowledgement on ${Object.keys(patch)[0]} status patches`, async () => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			await view.rerender({
				open: true,
				deviceId: "0",
				iface: { ...row(), ...patch },
			});
			expect(input("hotspot-confirm-name").value).toBe("typed-name");
			expect(input("hotspot-confirm-password").value).toBe("typed-password");
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("true");
			expect(prepare).toHaveBeenCalledTimes(1);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() =>
				expect(start).toHaveBeenCalledWith({
					device: "0",
					incarnation: "radio-A",
				}),
			);
			expect(prepare).toHaveBeenLastCalledWith({
				device: "0",
				incarnation: "radio-A",
				name: "typed-name",
				password: "typed-password",
			});
		});
	}

	for (const change of ["token", "device", "link", "session"] as const) {
		it(`reloads the gate and withdraws consent after a ${change} change`, async () => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			} else if (change === "session") {
				await view.rerender({ open: false, deviceId: "0", iface: row() });
				await view.rerender({ open: true, deviceId: "0", iface: row() });
				await gate();
			} else {
				await view.rerender({
					open: true,
					deviceId: change === "device" ? "1" : "0",
					iface: row(change === "token" ? "radio-B" : "radio-A"),
				});
			}
			await ready();
			expect(
				screen.queryByTestId("hotspot-confirm-radio-changed"),
			).toBeTruthy();
			expect(input("hotspot-confirm-name").value).toBe(
				change === "token" ? "radio-B-stored" : "radio-A-stored",
			);
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("false");
			expect(
				screen.getByTestId("hotspot-confirm-activate").hasAttribute("disabled"),
			).toBe(true);
			expect(start).toHaveBeenCalledTimes(0);
		});

		it(`ignores a saved pair returned after a ${change} invalidation`, async () => {
			const pending =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			prepare.mockReturnValueOnce(pending.promise);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			} else if (change === "session") {
				await view.rerender({ open: false, deviceId: "0", iface: row() });
				await view.rerender({ open: true, deviceId: "0", iface: row() });
				await gate();
			} else {
				await view.rerender({
					open: true,
					deviceId: change === "device" ? "1" : "0",
					iface: row("radio-B"),
				});
			}
			await ready();
			pending.resolve({
				success: true,
				name: "typed-name",
				password: "typed-password",
			});
			await tick();
			expect(start).toHaveBeenCalledTimes(0);
			expect(input("hotspot-confirm-name").value).toBe(
				change === "link" || change === "session"
					? "radio-A-stored"
					: "radio-B-stored",
			);
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("false");
		});
	}

	it("does not resurrect the first A load after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		prepare.mockReturnValueOnce(old.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Enable Hotspot" }),
		);
		await view.rerender({ open: true, deviceId: "1", iface: row("radio-B") });
		await ready();
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		await ready();
		old.resolve({
			success: true,
			name: "obsolete-A",
			password: "obsolete-password",
		});
		await tick();
		expect(input("hotspot-confirm-name").value).toBe("radio-A-stored");
		expect(
			screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
		).toBe("false");
	});

	it("does not dispatch start when A's saved draft returns after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		prepare.mockReturnValueOnce(old.promise);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await view.rerender({ open: true, deviceId: "1", iface: row("radio-B") });
		await ready();
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		await ready();
		old.resolve({
			success: true,
			name: "typed-name",
			password: "typed-password",
		});
		await tick();
		expect(start).toHaveBeenCalledTimes(0);
		expect(input("hotspot-confirm-name").value).toBe("radio-A-stored");
		expect(
			screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
		).toBe("false");
	});

	it("withdraws a saving gate when its token disappears", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		prepare.mockReturnValueOnce(old.promise);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		const unproven = row();
		delete unproven.incarnation;
		await view.rerender({ open: true, deviceId: "0", iface: unproven });
		old.resolve({
			success: true,
			name: "typed-name",
			password: "typed-password",
		});
		await tick();
		expect(screen.getByTestId("hotspot-confirm-unavailable")).toBeTruthy();
		expect(start).toHaveBeenCalledTimes(0);
		expect(screen.queryByTestId("hotspot-confirm-ack")).toBeNull();
	});

	it("reopens the current gate with fresh consent on an optional start refusal", async () => {
		start.mockResolvedValueOnce(
			JSON.parse('{"success":false,"error":"radio-changed"}'),
		);
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await ready();
		expect(
			screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
		).toBe("false");
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	for (const change of ["token", "device", "link"] as const) {
		it(`ignores a late start refusal after a ${change} change`, async () => {
			const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotStart>>>();
			start.mockReturnValueOnce(old.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			}
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A"),
			});
			old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
			await tick();
			expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
			expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe(
				"pending",
			);
		});
	}

	it("ignores an old start refusal after the owner session is replaced", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotStart>>>();
		start.mockReturnValueOnce(old.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await view.rerender({ open: false, deviceId: "0", iface: row() });
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		// Unknown future refusal tokens arrive at the JSON boundary.
		old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
		await tick();
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe("pending");
	});

	for (const reason of [undefined, "permanent-mac-unresolved"] as const) {
		it(`withholds guarded actions without lifetime proof (${reason ?? "tokenless"})`, async () => {
			const iface = row();
			delete iface.incarnation;
			iface.degraded_reason = reason;
			render(HotspotDialog, { open: true, deviceId: "0", iface });
			await fireEvent.click(
				screen.getByRole("button", { name: "Enable Hotspot" }),
			);
			expect(
				screen.getByTestId("hotspot-confirm-unavailable").textContent,
			).toContain(reason ? "identified" : "update the device software");
			expect(prepare).toHaveBeenCalledTimes(0);
			expect(
				screen.getByTestId("hotspot-confirm-activate").hasAttribute("disabled"),
			).toBe(true);
		});
	}
});

describe("live editor binding and safe Stop", () => {
	it("keeps Stop available when a live tokenless AP replaces an open gate", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		const active = row("radio-A", true);
		delete active.incarnation;
		await view.rerender({ open: true, deviceId: "0", iface: active });
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		expect(input("hotspot-name").readOnly).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
		expect(rpc.wifi.hotspotStop).toHaveBeenCalledWith({ device: "0" });
	});
	it("keeps Stop available on an otherwise healthy tokenless live AP", async () => {
		const iface = row("radio-A", true);
		delete iface.incarnation;
		render(HotspotDialog, { open: true, deviceId: "0", iface });
		expect(input("hotspot-name").value).toBe("radio-A-stored");
		expect(input("hotspot-name").readOnly).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
		expect(rpc.wifi.hotspotStop).toHaveBeenCalledWith({ device: "0" });
	});
	it("preserves edits on a same-token replacement object", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "live-draft" },
		});
		await fireEvent.input(input("hotspot-password"), {
			target: { value: "live-password" },
		});
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: { ...row("radio-A", true), ifname: "renamed" },
		});
		expect(input("hotspot-name").value).toBe("live-draft");
		expect(input("hotspot-password").value).toBe("live-password");
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		expect(configure).toHaveBeenCalledWith({
			device: "0",
			incarnation: "radio-A",
			name: "live-draft",
			password: "live-password",
			channel: "auto",
			security: "wpa2",
		});
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"pending",
		);
	});

	for (const change of ["token", "device", "link", "session"] as const) {
		it(`reloads the live editor after a ${change} change and ignores its old save`, async () => {
			const old =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
			configure.mockReturnValueOnce(old.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "live-draft" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			}
			if (change === "session")
				await view.rerender({
					open: false,
					deviceId: "0",
					iface: row("radio-A", true),
				});
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A", true),
			});
			old.resolve({ success: false, error: "saving" });
			await tick();
			expect(input("hotspot-name").value).toBe(
				change === "token" ? "radio-B-stored" : "radio-A-stored",
			);
			expect(screen.getByTestId("hotspot-editor-radio-changed")).toBeTruthy();
			expect(
				getOperationPhase(
					wifiHotspotConfigOpKey(
						change === "device" ? "1" : "0",
						change === "token" ? "radio-B" : "radio-A",
					),
				),
			).toBe(change === "link" || change === "session" ? "pending" : "idle");
		});
	}

	for (const token of [undefined, "radio-A"]) {
		it(`keeps read-only credentials and Stop available for ${token ?? "tokenless"} degraded rows`, async () => {
			const iface = row(token, true);
			delete iface.incarnation;
			if (token) iface.incarnation = token;
			iface.degraded_reason = "unavailable";
			render(HotspotDialog, { open: true, deviceId: "0", iface });
			expect(input("hotspot-name").readOnly).toBe(true);
			expect(
				screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled"),
			).toBe(true);
			await fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
			expect(rpc.wifi.hotspotStop).toHaveBeenCalledWith({
				device: "0",
				...(token ? { incarnation: token } : {}),
			});
		});
	}
});

describe("mode owner and echoed settlement use the dispatched lifetime", () => {
	for (const change of ["token", "device", "link", "session"] as const) {
		it(`ignores an old mode refusal after a ${change} change`, async () => {
			const old =
				deferred<Awaited<ReturnType<typeof rpc.wifi.setAdapterMode>>>();
			mode.mockReturnValueOnce(old.promise);
			const modeView = (token: string, device = "0") =>
				deriveWifiAdapterModeView({ device, iface: row(token), phase: "idle" });
			let view = render(WifiModeSelector, {
				props: {
					view: modeView("radio-A"),
					context: { stationLinkLive: true, hotspotLive: false },
				},
			});
			await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
			await ready();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			}
			if (change === "session") {
				view.unmount();
				view = render(WifiModeSelector, {
					props: {
						view: modeView("radio-A"),
						context: { stationLinkLive: true, hotspotLive: false },
					},
				});
			} else {
				await view.rerender({
					view: modeView(
						change === "token" ? "radio-B" : "radio-A",
						change === "device" ? "1" : "0",
					),
					context: { stationLinkLive: true, hotspotLive: false },
				});
			}
			old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
			await tick();
			expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
			expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("pending");
		});
	}
	it("ignores an old mode response after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.setAdapterMode>>>();
		mode.mockReturnValueOnce(old.promise);
		const modeView = (token: string) =>
			deriveWifiAdapterModeView({
				device: "0",
				iface: row(token),
				phase: "idle",
			});
		const view = render(WifiModeSelector, {
			props: {
				view: modeView("radio-A"),
				context: { stationLinkLive: true, hotspotLive: false },
			},
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		expect(mode).toHaveBeenCalledWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-A",
		});
		await view.rerender({
			view: modeView("radio-B"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		await view.rerender({
			view: modeView("radio-A"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
		await tick();
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
	});

	for (const kind of ["config", "mode"] as const) {
		it(`ignores mismatched ${kind} frames and settles only the echoed dispatch key`, () => {
			wire.message("status", { wifi: { "0": row() } });
			const key = kind === "config" ? wifiHotspotConfigOpKey : wifiModeOpKey;
			beginOperation(key("0", "radio-A"), "hybrid");
			const frame = (token: string, success: boolean) =>
				kind === "config"
					? {
							hotspot: { config: { device: "0", incarnation: token, success } },
						}
					: {
							adapter_mode: {
								device: "0",
								incarnation: token,
								...(success ? { success } : { pending: true, mode: "hybrid" }),
							},
						};
			wire.message("wifi", frame("radio-B", false));
			wire.message("wifi", frame("radio-B", true));
			expect(getOperationPhase(key("0", "radio-A"))).toBe("pending");
			expect(getOperationPhase(key("0", "radio-B"))).toBe("idle");
			wire.message("wifi", frame("radio-A", true));
			expect(getOperationPhase(key("0", "radio-A"))).toBe("confirmed");
		});
	}
});
