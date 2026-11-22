import { expect, test } from "bun:test";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { persistEthernetRole } from "../modules/network/ethernet-role.ts";
import {
	A,
	attach,
	B,
	ETH,
	enabled,
	G,
	movedA,
	newPortB,
	noSerialB,
	P,
	placeholderB,
	plug,
	reload,
	seed,
	singletonA,
	toggle,
	twinA,
	twinB,
	useBondTwinFixture,
} from "./helpers/bond-twin-residual-fixture.ts";

useBondTwinFixture();

test("T1 / S1: after A-only enable and reload, the first scan publication excludes returning B", async () => {
	await seed([G]);
	await plug(twinA);
	expect(enabled(twinA)).toEqual([false]);
	await toggle(twinA, true);
	await reload();

	const publications = await plug(twinA, twinB);
	expect(resolveModemPhysicalIdentity(B.ifname).legacyLinkId).toBe(G);
	expect(publications).toEqual([[true, false]]);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("T2 / S3: the absent sibling returns at a port it never used", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	await plug(newPortB);
	expect(enabled(newPortB)).toEqual([false]);
});

test("T3 / S2: keeps B excluded when the twins were first recognized before A's enable", async () => {
	await seed([G], false);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([false, false]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("T4 / S18: explicitly enabling the sibling keeps both enabled after rescan and reload", async () => {
	await seed([G]);
	await plug(twinA, twinB);
	await toggle(twinA, true);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
	await toggle(twinB, true);
	await plug(twinA);
	await reload();
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, true]);
});

test("S23: a durable disable under another identity revokes the old group enable at that port", async () => {
	await seed([P]);
	await plug(placeholderB);
	expect(enabled(placeholderB)).toEqual([false]);
	await toggle(placeholderB, true);
	await plug(noSerialB);
	await toggle(noSerialB, false);
	await reload();
	await plug(noSerialB);
	expect(enabled(noSerialB)).toEqual([false]);
	await toggle(noSerialB, true);
	await plug(placeholderB);
	expect(enabled(placeholderB)).toEqual([false]);
});

test("S11: a moved twin stays out until enabled at the new port", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(movedA);
	expect(enabled(movedA)).toEqual([false]);
	await toggle(movedA, true);
	await reload();
	await plug(movedA);
	expect(enabled(movedA)).toEqual([true]);
});

test("S10 / D2a: enabling a pending twin does not authorize the as-yet unseen group", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await reload();
	attach([twinA, twinB], B.ifname);
	await toggle(twinB, true, false);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});

test("S12: a serial-less device of the pinned product stays out until explicitly enabled", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	await reload();
	await plug(noSerialB);
	expect(enabled(noSerialB)).toEqual([false]);
	await toggle(noSerialB, true);
	expect(enabled(noSerialB)).toEqual([true]);
});

test("R1: a different USB product keeps its uplink after Ethernet is disabled at a scan-pinned port", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	await plug();

	const replacement = { ...noSerialB, idProduct: "9091" };
	const publications = await plug(replacement);
	const { anchor, legacyLinkId, pid } = resolveModemPhysicalIdentity(B.ifname);
	expect([anchor, legacyLinkId, pid]).toEqual(["id-path", undefined, "9091"]);
	attach([replacement], undefined, [ETH]);
	await toggle(ETH, false);
	expect({ publications, afterEthernetOff: enabled(replacement, ETH) }).toEqual(
		{
			publications: [[true]],
			afterEthernetOff: [true, false],
		},
	);
});

test("a dormant scan pin survives a different product and restart but does not override a port disable", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	const replacement = { ...noSerialB, idProduct: "9091" };
	expect(await plug(replacement)).toEqual([[true]]);
	await toggle(replacement, true);
	await reload();
	expect(await plug(twinA, noSerialB)).toEqual([[true, false]]);
	await toggle(noSerialB, false);
	await reload();
	expect(await plug(replacement)).toEqual([[false]]);
});

test("#688 H1: an unrelated group enable cannot lift an exact exclusion on same-port serial loss", async () => {
	await seed([G, P]);
	await plug(twinA, twinB);
	await plug(placeholderB);
	await toggle(placeholderB, true);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([false, false]);
	await toggle(twinA, true);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
	const portId = resolveModemPhysicalIdentity(B.ifname).linkId;
	await reload();
	await plug(twinA, noSerialB);
	const identity = resolveModemPhysicalIdentity(B.ifname);
	expect(identity.linkId).toBe(portId);
	expect(identity.legacyLinkId).toBeUndefined();
	expect(enabled(twinA, noSerialB)).toEqual([true, false]);
});

test("#688 H2: a pending singleton OFF then ON takes effect once its identity settles", async () => {
	attach([singletonA], A.ifname);
	await toggle(singletonA, false);
	await toggle(singletonA, true, false);
	await plug(singletonA);
	expect(enabled(singletonA)).toEqual([true]);
});

test("#688 H3: an eth0 enable during the shared-LAN transition takes effect back in uplink", async () => {
	attach([]);
	await toggle(ETH, false);
	persistEthernetRole(ETH.ifname, "shared-lan");
	await toggle(ETH, true, false);
	attach([]);
	expect(enabled(ETH)).toEqual([false]);
	persistEthernetRole(ETH.ifname, "uplink");
	attach([]);
	expect(enabled(ETH)).toEqual([true]);
});

async function evictKnownGroup() {
	for (let i = 0; i < 64; i++) {
		const serial = `ConstructedNewPair${i}`;
		await plug({ ...A, serial }, { ...B, serial });
	}
	await reload();
}

test("#688 H4 / S8: after eviction, a lone-serial disable then enable retains main's result", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await evictKnownGroup();
	await plug(twinA);
	expect(resolveModemPhysicalIdentity(A.ifname).linkId).toBe(G);
	await toggle(twinA, false);
	await toggle(twinA, true);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, true]);
});

test("S9: an evicted sibling alone matches main, but is excluded again when the pair is relearned", async () => {
	await seed([G]);
	await plug(twinA);
	await toggle(twinA, true);
	await evictKnownGroup();
	await plug(twinB);
	expect(resolveModemPhysicalIdentity(B.ifname).linkId).toBe(G);
	expect(enabled(twinB)).toEqual([true]);
	await plug(twinA, twinB);
	expect(enabled(twinA, twinB)).toEqual([true, false]);
});
