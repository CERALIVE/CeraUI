import { expect, test } from "bun:test";
import { call } from "@orpc/server";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import { hotspotStartProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

test.each(["omitted", "supplied"] as const)(
	"Start terminal frames keep their legacy bytes and echo only a supplied attempt (%s)",
	async (mode) => {
		const f = await wifiFrameFixture();
		try {
			const attempt = mode === "supplied" ? crypto.randomUUID() : undefined;
			const correlation = attempt === undefined ? {} : { attempt };
			expect(
				await call(
					hotspotStartProcedure,
					{ device: "0", incarnation: f.before, ...correlation },
					{ context: f.context },
				),
			).toEqual({ success: true, accepted: true });
			expect(await wifiHotspotStart({ device: 7, ...correlation })).toEqual({
				success: false,
				error: "no-device",
			});
			const echo = attempt === undefined ? "" : `,"attempt":"${attempt}"`;
			expect(f.frames.filter((raw) => raw.includes('"start"'))).toEqual([
				`{"wifi":{"hotspot":{"start":{"device":0,"success":true${echo}}}}}`,
				`{"wifi":{"hotspot":{"start":{"device":7,"error":"no-device"${echo}}}}}`,
			]);
		} finally {
			await f.restore();
		}
	},
);
