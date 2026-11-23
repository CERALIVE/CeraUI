import type { LinkTelemetryEntry, StatusResponse } from "@ceraui/rpc/schemas";
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const links: LinkTelemetryEntry[] = [
	{ conn_id: "0", link_id: "wired", iface: "test-wired", bitrate_bps: 2_000_000, rtt_ms: 20, nak_count: 0, weight_percent: 50, stale: false },
	{ conn_id: "1", link_id: "wifi", iface: "test-wireless", bitrate_bps: 1_000_000, rtt_ms: 50, nak_count: 0, weight_percent: 50, stale: false },
];

test.describe("Live glance", () => {
	let send: (status: StatusResponse) => void;
	test.beforeEach(async ({ page }) => {
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			socket = ws;
			ws.connectToServer().onMessage((raw) => {
				if (typeof raw !== "string") return ws.send(raw);
				const value: unknown = JSON.parse(raw);
				if (!isRecord(value) || !isRecord(value.status)) return ws.send(raw);
				delete value.status.is_streaming;
				delete value.status.stream_lifecycle;
				delete value.status.linkTelemetry;
				delete value.status.link_telemetry_waiting;
				ws.send(JSON.stringify(value));
			});
		});
		await page.goto("/");
		await ensureAuthenticated(page);
		let seq = 9_000_000;
		send = (status) => {
			if (!socket) throw new Error("Missing Live control socket");
			socket.send(JSON.stringify({ status, seq: ++seq }));
		};
	});

	test("both sending links fit above the fixed bar on landscape entry @mobile-only", async ({ page }, info) => {
		await page.setViewportSize({ width: 844, height: 390 });
		await navigateTo(page, "settings");
		send({ is_streaming: true, stream_lifecycle: "streaming", linkTelemetry: { links, measured_bps: 3_000_000 } });
		await navigateTo(page, "live");
		const glance = page.getByRole("region", { name: "Stream", exact: true });
		const bar = page.getByTestId("live-bar");
		await expect(glance.getByRole("listitem")).toHaveCount(2);
		await expect(glance.getByText("2 Mbps", { exact: true })).toBeVisible();
		await expect(glance.getByText("1 Mbps", { exact: true })).toBeVisible();
		let geometry = { cardBox: await glance.boundingBox(), barBox: await bar.boundingBox(), scrollY: await page.evaluate(() => window.scrollY) };
		try {
			await expect.poll(async () => {
				geometry = { cardBox: await glance.boundingBox(), barBox: await bar.boundingBox(), scrollY: await page.evaluate(() => window.scrollY) };
				const { cardBox, barBox, scrollY } = geometry;
				return cardBox && barBox && scrollY === 0 && cardBox.y >= 0 && cardBox.y + cardBox.height <= barBox.y;
			}).toBe(true);
		} finally {
			await info.attach("landscape-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
		}
		await expect(bar.getByRole("button", { name: "Stop Stream" })).toBeInViewport({ ratio: 1 });
	});

	test("colliding sender IDs keep distinct visible colors and their measured rates across reorder @mobile-only", async ({ page }, info) => {
		await navigateTo(page, "live");
		send({ is_streaming: true, stream_lifecycle: "streaming", linkTelemetry: { links, measured_bps: 3_000_000 } });
		const rows = page.getByRole("region", { name: "Stream", exact: true }).getByRole("listitem");
		// The painted fill is inside the decorative track on both revisions.
		const paint = (i: number) => rows.nth(i).locator('[aria-hidden="true"] > div').evaluate((el) => getComputedStyle(el).backgroundColor);
		await expect(rows.nth(0)).toContainText(/test-wired.*2 Mbps/);
		await expect(rows.nth(1)).toContainText(/test-wireless.*1 Mbps/);
		const first = await paint(0);
		const second = await paint(1);
		await info.attach("link-colors", {
			body: JSON.stringify({ wired: first, wifi: second }),
			contentType: "application/json",
		});
		expect(first).not.toBe(second);
		send({ linkTelemetry: { measured_bps: 3_000_000, links: links.toReversed().map((link, i) => ({ ...link, conn_id: String(i) })) } });
		await expect(rows.nth(0)).toContainText(/test-wireless.*1 Mbps/);
		await expect(rows.nth(1)).toContainText(/test-wired.*2 Mbps/);
		expect(await paint(0)).toBe(second);
		expect(await paint(1)).toBe(first);
	});
});
