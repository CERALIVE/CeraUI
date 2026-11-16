import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { sourceSelectionFixture } from "./helpers/applied-source-selection.ts";
import { OSMO_STABLE, osmo } from "./helpers/dual-mode-camera.ts";

const cases = [
	{
		name: "unknown live identity",
		stableId: undefined,
		anchor: OSMO_STABLE,
		mode: "uvc_h264",
		pipeline: "libuvch264",
		savedMode: undefined,
	},
	{
		name: "matching positive identity",
		stableId: OSMO_STABLE,
		anchor: OSMO_STABLE,
		mode: "mjpeg",
		pipeline: "usb_mjpeg",
		savedMode: "mjpeg",
	},
	{
		name: "different live identity at the saved node",
		stableId: "usb:replacement",
		anchor: OSMO_STABLE,
		mode: "uvc_h264",
		pipeline: "libuvch264",
		savedMode: undefined,
	},
	{
		name: "legacy selection without an anchor",
		stableId: OSMO_STABLE,
		anchor: undefined,
		mode: "uvc_h264",
		pipeline: "libuvch264",
		savedMode: undefined,
	},
] as const;

for (const row of cases) {
	test(`saved MJPEG requires positive identity proof: ${row.name}`, async () => {
		const f = await sourceSelectionFixture();
		await f.write({ input_mode: "mjpeg" });
		getConfig().source_stable_id = row.anchor;
		f.devices.splice(0, 1, { ...osmo(), stable_id: row.stableId });
		const selected = f.sources().find((source) => source.id === "video1");
		if (selected?.origin !== "capture") throw new Error("missing capture row");

		const result = await f.write({ source: "video1" });
		const saved = await f.read();

		expect(selected.selectedInputMode).toBe(row.mode);
		expect(result.success).toBe(true);
		expect(saved.pipeline).toBe(row.pipeline);
		expect(saved.input_mode).toBe(row.savedMode);
		expect(saved.source_stable_id).toBe(row.stableId);
	});
}
