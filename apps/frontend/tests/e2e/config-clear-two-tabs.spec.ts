import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { isBackendSocket } from "./helpers/backend-socket.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * A setting cleared in tab A while tab B is disconnected, read in B once it is
 * back. A saves through its own Encoder dialog and the real mock backend; B's
 * socket is proxied so it can be cut and its reconnect pull witnessed.
 */

test.use({ backendScenario: "caps-full" });

async function openLive(page: Page): Promise<void> {
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
}

async function openEncoder(page: Page): Promise<Locator> {
	await page.getByTestId("open-encoder-dialog").click();
	const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function saveEncoder(dialog: Locator): Promise<void> {
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
}

/** Tab B: the same signed-in device session, on a link this test can cut. */
async function openTabB(page: Page, port: number) {
	const tab = await page.context().newPage();
	let online = true;
	let losesConfigPushes = false;
	let pulled = false;
	let link: { page: WebSocketRoute; device: WebSocketRoute } | undefined;
	await tab.routeWebSocket(isBackendSocket, (route) => {
		if (!online) {
			void route.close();
			return;
		}
		const device = route.connectToServer();
		link = { page: route, device };
		let pull: string | undefined;
		route.onMessage((message) => {
			const request = JSON.parse(String(message));
			if (request.path?.join(".") === "streaming.getConfig") pull = request.id;
			device.send(message);
		});
		device.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (losesConfigPushes && "config" in frame) return;
			route.send(message);
			if (pull !== undefined && frame.id === pull) pulled = true;
		});
	});
	await tab.addInitScript((socketPort: number) => {
		(window as { __ceraSocketPort?: number }).__ceraSocketPort = socketPort;
	}, port);
	await openLive(tab);
	return {
		tab,
		cut: async () => {
			online = false;
			await link?.page.close();
			await link?.device.close();
		},
		/** Back online; resolves once the device answered B's reconnect pull. */
		restore: async (options: { losesConfigPushes: boolean }) => {
			losesConfigPushes = options.losesConfigPushes;
			pulled = false;
			online = true;
			await expect.poll(() => pulled, { timeout: 45_000 }).toBe(true);
		},
	};
}

for (const losesConfigPushes of [false, true]) {
	test(`tab B, offline while tab A saved Encoder Automatic, shows Automatic and keeps autostart once it reconnects${
		losesConfigPushes ? ", on its reconnect pull alone" : ""
	}`, async ({ page, backendRpc, workerBackend }) => {
		await backendRpc.call(["streaming", "setConfig"], { source: "usb" });
		await backendRpc.call(["system", "setAutostart"], { autostart: true });
		await openLive(page);
		const { tab, cut, restore } = await openTabB(page, workerBackend.port);
		const savedCodec = async () =>
			(
				await backendRpc.call<{ video_codec?: string }>([
					"streaming",
					"getConfig",
				])
			).video_codec;

		// A picks a manual format, and B hears of it.
		const encoderA = await openEncoder(page);
		await encoderA.getByTestId("encoder-format-manual").click();
		await encoderA.getByTestId("encoder-format-h264").click();
		await saveEncoder(encoderA);
		await expect.poll(savedCodec).toBe("h264");
		const encoderB = await openEncoder(tab);
		const manualB = encoderB.getByTestId("encoder-format-manual");
		await expect(manualB).toHaveAttribute("aria-checked", "true");
		await tab.keyboard.press("Escape");
		await expect(encoderB).toBeHidden();

		// A goes back to Automatic while B is off the device.
		await cut();
		await openEncoder(page);
		await encoderA.getByTestId("encoder-format-manual").click();
		await saveEncoder(encoderA);
		await expect.poll(savedCodec).toBeUndefined();
		// A's own store heard the clear: its dialog reopens on Automatic.
		await openEncoder(page);
		await expect(
			encoderA.getByTestId("encoder-format-manual"),
		).toHaveAttribute("aria-checked", "false");
		await page.keyboard.press("Escape");
		await expect(encoderA).toBeHidden();

		await restore({ losesConfigPushes });

		await openEncoder(tab);
		await expect(manualB).toHaveAttribute("aria-checked", "false");
		await expect(
			encoderB.getByTestId("encoder-format-automatic"),
		).toHaveAttribute("data-active", "true");
		await tab.keyboard.press("Escape");
		await expect(encoderB).toBeHidden();
		await navigateTo(tab, "settings");
		await expect(
			tab.getByTestId("settings-autostart").getByRole("switch"),
		).toHaveAttribute("aria-checked", "true");
		await tab.close();
	});
}
