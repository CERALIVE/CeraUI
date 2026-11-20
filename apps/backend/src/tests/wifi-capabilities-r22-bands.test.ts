import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIwPhyChannels } from "../modules/wifi/regdomain.ts";
import { parseIwPhyCapabilities } from "../modules/wifi/wifi-capabilities.ts";

for (const phy of ["phy0", "phy1", "phy2", "phy3"]) {
	const captured = readFileSync(
		new URL(`./fixtures/wifi/iw-phy-r22-${phy}.txt`, import.meta.url),
		"utf8",
	);

	test(`complete iw 6.9 ${phy} retains supported bands beside S1G`, () => {
		const parsed = parseIwPhyCapabilities(captured);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect([...parsed.value.keys()]).toEqual([phy]);
		expect(parsed.value.get(phy)?.bands).toEqual(["2.4", "5", "6"]);
		expect(parsed.value.get(phy)?.apModes).toEqual(["2.4", "5", "6"]);
		expect(parseIwPhyChannels(captured).get(phy)).toContainEqual({
			channel: 6,
			freqMhz: 2437,
			band: "bg",
		});
	});
}

const band = (rows: string) =>
	`Wiphy phy0\n\tSupported interface modes:\n\t\t * managed\n\t\t * AP\n\tBand 1:\n\t\tFrequencies:\n${rows}`;

for (const rows of [
	"",
	"\t\t\t* 2437.0 MHz (20.0 dBm)\n",
	"\t\t\t* 2437.0 MHz [6] (20.0 dBm)\n\t\t\t* broken\n",
	"\t\t\t* 902.500 MHz (disabled)\n\t\t\t* broken\n",
	"\t\t\t* 0 MHz (disabled)\n",
	`\t\t\t* ${"9".repeat(400)} MHz (disabled)\n`,
]) {
	test(`malformed frequency block still fails: ${JSON.stringify(rows)}`, () => {
		expect(parseIwPhyCapabilities(band(rows)).ok).toBe(false);
	});
}

test("a well-formed unrepresented-only radio has no represented bands", () => {
	const parsed = parseIwPhyCapabilities(
		band("\t\t\t* 902.500 MHz (disabled)\n"),
	);
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error(parsed.reason);
	expect(parsed.value.get("phy0")?.bands).toEqual([]);
	expect(parsed.value.get("phy0")?.apModes).toEqual([]);
});
