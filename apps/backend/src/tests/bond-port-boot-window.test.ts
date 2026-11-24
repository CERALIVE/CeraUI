import { expect, test } from "bun:test";
import {
	isBondOptedOut,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	all,
	attach,
	firstOnly,
	inAutoMode,
	modems,
	restart,
	sortedSenders,
	toggle,
	useGuard,
	useObserver,
} from "./helpers/bond-port-boot-window-fixture.ts";
import {
	at,
	b,
	first,
	included,
	installBondPortFixture,
	reload,
	scan,
	second,
} from "./helpers/bond-port-record-fixture.ts";

installBondPortFixture();

test.each([true, false])(
	"BW1/BW2 direct: first toggle is ON=%j",
	async (on) => {
		await inAutoMode(async () => {
			setPersistentBondOptOut(first, !on);
			setPersistentBondOptOut(on ? second : first, false, "legacy");
			expect(
				[first, second].map((name) => !isBondOptedOut(name, "legacy")),
			).toEqual([true, on]);
			await restart();
			expect(included(first, second)).toEqual([true, on]);
		});
	},
);

test.each([true, false])("BW1r/BW2 RPC: first toggle is ON=%j", async (on) => {
	await inAutoMode(async () => {
		const deviceIsReal = useGuard();
		expect(sortedSenders()).toEqual(["eth0"]);
		await toggle("first", on);
		deviceIsReal(false);
		await toggle(on ? "second" : "first", true);
		const expected = on ? all : firstOnly;
		expect(sortedSenders()).toEqual(expected);
		await restart();
		deviceIsReal(true);
		const pending = sortedSenders();
		deviceIsReal(false);
		expect({ pending, settled: sortedSenders() }).toEqual({
			pending: expected,
			settled: expected,
		});
	});
});

test.each([true, false])(
	"E1 on the real boot observer: first toggle is ON=%j",
	async (on) => {
		await inAutoMode(async () => {
			const settle = useObserver();
			await toggle("first", on);
			await settle("emulated");
			await toggle(on ? "second" : "first", true);
			const expected = on ? all : firstOnly;
			expect(sortedSenders()).toEqual(expected);
			await restart();
			const settleAgain = useObserver();
			const pending = sortedSenders();
			await settleAgain("emulated");
			expect({ pending, settled: sortedSenders() }).toEqual({
				pending: expected,
				settled: expected,
			});
		});
	},
);

test.each(["real", "errored"] as const)(
	"E1: acknowledged ON survives a %s next probe",
	async (result) => {
		await inAutoMode(async () => {
			const settle = useObserver();
			await toggle("first", false);
			await settle("emulated");
			await toggle("first", true);
			await restart();
			const settleAgain = useObserver();
			const pending = sortedSenders();
			await settleAgain(result);
			expect({ pending, settled: sortedSenders() }).toEqual({
				pending: firstOnly,
				settled: firstOnly,
			});
		});
	},
);

test.each(["effective", "legacy"] as const)(
	"a sibling OFF survives switching from a prior %s ON with restarts",
	async (firstWriter) => {
		await inAutoMode(async () => {
			const deviceIsReal = useGuard();
			deviceIsReal(firstWriter === "effective");
			await toggle("first", true);
			await restart();
			deviceIsReal(firstWriter !== "effective");
			await toggle("second", false);
			await restart();
			deviceIsReal(true);
			expect(sortedSenders()).toEqual(firstOnly);
			deviceIsReal(false);
			expect(sortedSenders()).toEqual(firstOnly);
		});
	},
);

test("a settled ON does not clear the pair default for an absent twin", async () => {
	await inAutoMode(async () => {
		const deviceIsReal = useGuard();
		await scan(modems[0]);
		await toggle("first", false);
		await reload();
		await scan(modems[0]);
		deviceIsReal(false);
		await toggle("first", true);
		await restart();
		deviceIsReal(true);
		expect(sortedSenders()).toEqual(firstOnly);
	});
});

test("seed 7607: a twin turned ON after a replacement visit survives another pending boot", async () => {
	await inAutoMode(async () => {
		const deviceIsReal = useGuard();
		const secondOnly = ["eth0", second].sort();
		const replacement = at({ ...b, idVendor: "1e0e" }, "");
		await toggle("second", false);
		await scan(modems[0], replacement);
		await reload();
		await scan(modems[0], replacement);
		await attach();
		deviceIsReal(false);
		await toggle("second", true);
		expect(sortedSenders()).toEqual(secondOnly);
		await restart();
		deviceIsReal(true);
		expect(sortedSenders()).toEqual(secondOnly);
		await scan(modems[0], replacement);
		await attach();
		expect(sortedSenders()).toEqual(secondOnly);
	});
});
