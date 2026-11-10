// @vitest-environment jsdom
import { statusResponseSchema, wifiStatusSchema } from "@ceraui/rpc/schemas";
import { afterEach, expect, test } from "vitest";
import {
	getWifi,
	ingestPulledStatus,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

afterEach(resetState);

for (const incarnation of [undefined, "opaque-observation"]) {
	test(`unchanged frontend hydrates Wi-Fi with incarnation=${incarnation}`, () => {
		const wifi = {
			"0": {
				ifname: "wlan0",
				conn: "",
				hw: "radio",
				saved: {},
				supports_hotspot: true,
				...(incarnation === undefined ? {} : { incarnation }),
			},
		};
		expect(wifiStatusSchema.parse(wifi)).toStrictEqual(wifi);
		const status = statusResponseSchema.parse({ wifi });
		ingestPulledStatus(status);
		expect(getWifi()).toStrictEqual(wifi);
	});
}
