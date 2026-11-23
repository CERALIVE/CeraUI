import type { WifiStatus } from "@ceraui/rpc/schemas";
import { expect, test } from "./fixtures/index.js";

test("a stale page token cannot start the replacement radio", async ({ pageRpc, authedPage }) => {
	await expect(authedPage.locator("#main-content")).toBeVisible();
	const before = await pageRpc.call<WifiStatus>(["wifi", "getStatus"]);
	const entry = Object.entries(before).find(([, row]) => row.supports_hotspot && row.incarnation);
	if (!entry) throw new Error("The local mock radio must have an identity token");
	const [device, row] = entry;
	await pageRpc.call(["dev", "rebindWifi"], { device });
	expect(await pageRpc.call(["wifi", "hotspotStart"], { device, incarnation: row.incarnation })).toEqual({
		success: false, error: "radio-changed",
	});
	const after = await pageRpc.call<WifiStatus>(["wifi", "getStatus"]);
	expect(after[device]).toBeDefined();
	expect(after[device]?.incarnation).not.toBe(row.incarnation);
	expect(after[device]?.mode).not.toBe("hotspot");
	expect(after[device]?.hotspot).toBeUndefined();
});
