import { expect, test } from "bun:test";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";

for (const array of [false, true]) {
	test(`remote projection strips row tokens and preserves legacy container array=${array}`, () => {
		const station = {
			ifname: "wlan0",
			incarnation: "station-token",
			saved: {},
		};
		const ap = {
			ifname: "wlan1",
			incarnation: "ap-token",
			hotspot: { name: "AP", password: "secret" },
		};
		const legacyStation = { ifname: "wlan0", saved: {} };
		const legacyAp = {
			ifname: "wlan1",
			hotspot: { name: "AP", password: "secret" },
		};
		const wifi = array
			? [station, null, ap]
			: { first: station, second: null, third: ap };
		const expected = array
			? [legacyStation, null, legacyAp]
			: { first: legacyStation, second: null, third: legacyAp };
		const local = { first: "preserved", wifi, last: undefined };
		const original = structuredClone(local);
		expect(projectRemoteStatus(local)).toStrictEqual({
			...local,
			wifi: expected,
		});
		expect(JSON.stringify(projectRemoteStatus(local))).toBe(
			JSON.stringify({ ...local, wifi: expected }),
		);
		expect(local).toStrictEqual(original);
	});
}
