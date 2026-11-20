import { expect, test } from "bun:test";
import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { hotspotStartProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

test("the Start terminal echoes only the initiating attempt and legacy frames remain valid", async () => {
	const f = await wifiFrameFixture();
	try {
		const attempt = crypto.randomUUID();
		expect(
			await call(
				hotspotStartProcedure,
				{
					device: "0",
					incarnation: f.before,
					attempt,
				},
				{ context: f.context },
			),
		).toEqual({ success: true, accepted: true });
		const outcomes = f.frames.flatMap((raw) => {
			const decoded = wifiMessageSchema.parse(JSON.parse(raw).wifi);
			return decoded.hotspot?.start ? [decoded.hotspot.start] : [];
		});
		expect(outcomes).toEqual([{ device: 0, success: true, attempt }]);
		expect(
			wifiMessageSchema.parse({
				hotspot: { start: { device: 0, error: "radio-changed" } },
			}).hotspot?.start,
		).toEqual({ device: 0, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});
