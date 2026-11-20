import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseApStaConcurrencySupport } from "../modules/wifi/wifi-ap-sta-capability.ts";
import {
	parseInterfaceCombination,
	parseIwPhyCapabilities,
} from "../modules/wifi/wifi-capabilities.ts";

for (const capacity of [1, 2, 2048]) {
	test(`shared managed/AP capacity ${capacity} accounts for both roles`, () => {
		expect(
			parseInterfaceCombination(
				`* #{ managed, AP, mesh point, P2P-client, P2P-GO } <= ${capacity}, total <= 2050, #channels <= 1`,
			),
		).toEqual({ supported: capacity >= 2, sameChannelOnly: true });
	});
}

for (const entry of [
	"* #{ managed, AP } <= 2, total <= 1, #channels <= 1",
	"* #{ managed, AP } <= 2, total <= 2, #channels <= 0",
	"* #{ managed, AP } <= 2, total <= 2",
	"* #{ managed } <= 2, total <= 2, #channels <= 1 * #{ AP } <= 2, total <= 2, #channels <= 2",
	"* #{ managed, AP } <= 1, total <= 2, #channels <= 2 * #{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1",
]) {
	test(`complete alternatives preserve slot and channel bounds: ${entry}`, () => {
		expect(parseInterfaceCombination(entry)).toEqual({
			supported: entry.includes("* #{ managed } <= 1, #{ AP }"),
			sameChannelOnly: true,
		});
	});
}

test("a usable multichannel alternative supplies its own channel bound", () => {
	expect(
		parseInterfaceCombination(
			"* #{ managed } <= 1, total <= 1, #channels <= 1 * #{ managed, AP } <= 2, total <= 2, #channels <= 2",
		),
	).toEqual({ supported: true, sameChannelOnly: false });
});

for (const phy of ["phy0", "phy1", "phy2", "phy3"]) {
	test(`real iw 6.9 ${phy} publishes the same shared-group verdict as slot accounting`, () => {
		const text = readFileSync(
			new URL(`./fixtures/wifi/iw-phy-r22-${phy}.txt`, import.meta.url),
			"utf8",
		);
		expect(parseApStaConcurrencySupport(text)).toBe(true);
		const parsed = parseIwPhyCapabilities(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.value.get(phy)?.staApCombo).toEqual({
			supported: true,
			sameChannelOnly: true,
		});
	});
}
