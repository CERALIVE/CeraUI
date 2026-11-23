import { expect, test } from "bun:test";
import {
	attach,
	ETH,
	enabled,
	G,
	noSerialB,
	plug,
	reload,
	seed,
	toggle,
	twinA,
	twinB,
	useBondTwinFixture,
} from "./helpers/bond-twin-residual-fixture.ts";

useBondTwinFixture();

test("RA-min: the same-port enable survives serial recovery and reload", async () => {
	await seed([G]);
	await plug(twinA, twinB);
	await toggle(twinA, true);
	await plug(twinA, noSerialB);
	await toggle(noSerialB, true);
	expect(enabled(twinA, noSerialB)).toEqual([true, true]);
	await reload();
	expect(await plug(twinA, twinB)).toEqual([[true, true]]);
});

test("RA-strand: serial recovery cannot drop the remaining uplink after Ethernet OFF", async () => {
	await seed([G]);
	await plug(twinA, twinB);
	await toggle(twinA, true);
	await plug(noSerialB);
	attach([noSerialB], undefined, [ETH]);
	await toggle(noSerialB, true);
	await toggle(ETH, false);
	await plug(twinB);
	expect(enabled(twinB, ETH)).toEqual([true, false]);
});

test("RA-fresh: OFF then split and enable survives serial recovery without a seeded group", async () => {
	await seed([], false);
	await plug(twinA);
	await toggle(twinA, false);
	await plug(twinA, twinB);
	await toggle(twinA, true);
	await plug(twinA, noSerialB);
	await toggle(noSerialB, true);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, true]);
});

const standardB = { ...twinB, product: "Constructed modem variant" };

test.each([
	["D1-pid", { ...standardB, idProduct: "81d8" }],
	["D1-product", { ...standardB, product: "Constructed alternate mode" }],
] as const)(
	"%s: an include survives the original USB descriptor returning",
	async (_name, alternateB) => {
		await seed([G]);
		await plug(twinA);
		await toggle(twinA, true);
		await plug(twinA, standardB);
		expect(await plug(twinA, alternateB)).toEqual([[true, true]]);
		await toggle(alternateB, true);
		await reload();
		expect(await plug(twinA, standardB)).toEqual([[true, true]]);
	},
);

test("D1-strand: returning to the original USB mode does not drop the last included uplink", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, standardB);
	const alternateB = { ...standardB, idProduct: "81d8" };
	await plug(alternateB);
	attach([alternateB], undefined, [ETH]);
	await toggle(alternateB, true);
	await toggle(ETH, false);
	await plug(standardB);
	expect(enabled(standardB, ETH)).toEqual([true, false]);
});

test("G1: a same-VID:PID replacement with a distinct USB product string keeps its uplink", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, { ...twinB, product: "Constructed modem variant" });
	await plug();
	const replacement = {
		...noSerialB,
		product: "Constructed replacement variant",
	};
	const publications = await plug(replacement);
	attach([replacement], undefined, [ETH]);
	await toggle(ETH, false);
	expect([publications, enabled(replacement, ETH)]).toEqual([
		[[true]],
		[true, false],
	]);
});

test("G1 identity limit: matching or absent descriptors cannot distinguish a serial-less replacement", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	const product = "Constructed modem variant";
	await plug(twinA, { ...twinB, product });
	await plug();
	expect(await plug({ ...noSerialB, product })).toEqual([[false]]);
	expect(await plug(noSerialB)).toEqual([[false]]);
	expect(enabled(noSerialB)).toEqual([false]);
	await toggle(noSerialB, true);
	expect(await plug(twinB)).toEqual([[true]]);
});

test.each(["9091", "0000"])(
	"PID %s sighting cannot replace the original pin evidence",
	async (idProduct) => {
		await seed([G]);
		await plug(twinA);
		await toggle(twinA, true);
		expect(await plug(twinA, twinB)).toEqual([[true, false]]);
		await plug({ ...twinB, idProduct });
		await reload();
		expect(await plug(noSerialB)).toEqual([[false]]);
	},
);
