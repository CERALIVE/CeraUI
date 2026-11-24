import { describe, expect, test } from "bun:test";
import { NETIF_ERR_DUPIPV4 } from "../modules/network/network-interfaces.ts";
import { assignSteeringMarks } from "../modules/network/uplink-steering/mark-allocation.ts";
import { harness, netif } from "./uplink-steering-state-test-fixtures.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

describe("readDesiredSteeringState", () => {
	test("plans both active identities that collide in the mark namespace", async () => {
		const h = harness({ markForIdentity: () => 0xca001100 });

		const state = await readReadySteeringState(h);
		expect(
			state.uplinks.map(({ ifname, mark, selectable }) => [
				ifname,
				mark,
				selectable,
			]),
		).toEqual([
			["wlan0", 0xca001200, true],
			["wwan0", 0xca001100, true],
		]);
		expect(h.planned.map(({ ifname, mark }) => [ifname, mark])).toEqual([
			["wlan0", 0xca001200],
			["wwan0", 0xca001100],
		]);
	});

	test.each([2, 3, 4])(
		"assigns the same %i colliders in reverse input order, skipping zero and reserved homes",
		async (count) => {
			const entries = [
				["eth9", netif("10.43.0.1")],
				["wwan9", netif("100.64.9.2")],
				...Array.from(
					{ length: count },
					(_, i) =>
						[
							`wwan${i}`,
							netif("100.64.1.2", "255.255.255.0", NETIF_ERR_DUPIPV4),
						] as const,
				),
			] as const;
			const expected = [
				...Array.from({ length: count }, (_, i) => [
					`wwan${i}`,
					i === 0 ? 0xcaffff00 : 0xca000000 + ((i + 1) << 8),
				]),
				["wwan9", 0xca000100],
			];
			for (const order of [entries, [...entries].reverse()]) {
				const h = harness({
					interfaces: () => Object.fromEntries(order),
					health: () => [],
					markForIdentity: (identity) =>
						identity === "id-path:wwan9" ? 0xca000100 : 0xcaffff00,
				});
				const state = await readReadySteeringState(h);
				expect(state.routes.map(({ ifname, mark }) => [ifname, mark])).toEqual(
					expected,
				);
				expect(
					h.planned
						.filter(({ ifname }) => ifname !== "wwan9")
						.map(({ sourceAddressUnique }) => sourceAddressUnique),
				).toEqual(Array.from({ length: count }, () => false));
			}
		},
	);

	test("keeps the saved incumbent on join and the saved prober on leave", async () => {
		const links = [
			["eth9", netif("10.43.0.1")],
			["wwan0", netif("100.64.1.2")],
			["wwan1", netif("100.64.1.2")],
		] as const;
		const fixtures = harness({
			interfaces: () => Object.fromEntries(links),
			health: () => [],
			physicalIdentity: (ifname) =>
				ifname === "wwan0" ? "constructed-twin-322" : "constructed-twin-386",
		});
		const incumbent = new Map([["constructed-twin-386", 0xca671800]]);
		const expected = [
			["wwan0", 0xca671900],
			["wwan1", 0xca671800],
		];
		for (const order of [links, [...links].reverse()]) {
			const ready = await readReadySteeringState(
				{
					...fixtures,
					interfaces: () => Object.fromEntries(order),
				},
				{
					hasAppliedState: true,
					resolveMarks: async (candidates) =>
						assignSteeringMarks(candidates, incumbent),
				},
			);
			expect(ready.routes.map(({ ifname, mark }) => [ifname, mark])).toEqual(
				expected,
			);
		}
		const surviving = new Map([
			["constructed-twin-322", 0xca671900],
			["constructed-twin-386", 0xca671800],
		]);
		const ready = await readReadySteeringState(
			{
				...fixtures,
				interfaces: () => Object.fromEntries(links.slice(0, 2)),
			},
			{
				hasAppliedState: true,
				resolveMarks: async (candidates) =>
					assignSteeringMarks(candidates, surviving),
			},
		);
		expect(ready.routes.map(({ ifname, mark }) => [ifname, mark])).toEqual([
			["wwan0", 0xca671900],
		]);
	});
});
