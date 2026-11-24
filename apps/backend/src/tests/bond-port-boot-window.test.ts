import { expect, test } from "bun:test";
import {
	isBondOptedOut,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import { setBondDisableGuardContext } from "../modules/network/network-interfaces.ts";
import { observeRealDeviceAtBoot } from "../modules/system/device-detection.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	first,
	G1,
	g1,
	included,
	installBondPortFixture,
	onRealDevice,
	pairs,
	reload,
	scan,
	second,
	senders,
	start,
} from "./helpers/bond-port-record-fixture.ts";
import { clearBondNetworkFixture } from "./helpers/bond-toggle-fixture.ts";

installBondPortFixture();
const modems = [at(a, g1), at(b, g1)] as const;
const paths = { first, second } as const;
type Twin = keyof typeof paths;

async function attach() {
	clearBondNetworkFixture();
	await scan(...modems);
	addUplinks(first);
}

async function restart() {
	await reload();
	await attach();
}

async function toggle(twin: Twin, enabled: boolean) {
	const ip = twin === "first" ? "198.51.100.3" : "198.51.100.2";
	expect(await configure(paths[twin], ip, enabled)).toMatchObject({
		success: true,
		applied: { enabled },
	});
}

const sortedSenders = () => senders().sort();
const all = ["eth0", first, second].sort();
const firstOnly = ["eth0", first].sort();

function useGuard() {
	let real = true;
	setBondDisableGuardContext(
		{ isStillReal: () => real, refresh: () => undefined },
		true,
	);
	return (value: boolean) => {
		real = value;
	};
}

function useObserver() {
	const gate = Promise.withResolvers<string>();
	const read = () => gate.promise;
	const observer = observeRealDeviceAtBoot(false, {
		getDeviceTypeOverride: () => undefined,
		isDevelopment: () => false,
		readDeviceTreeCompatible: read,
		readDeviceTreeModel: read,
		readCeraliveRelease: read,
		readDmiProductName: read,
		readDmiBoardName: read,
	});
	setBondDisableGuardContext(observer, true);
	return async (result: "real" | "emulated" | "errored") => {
		if (result === "errored") gate.reject(new Error("Probe read failed"));
		else gate.resolve(result === "real" ? "rockchip,rk3588" : "");
		expect(await observer.ready).toBe(result === "real");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(observer.isStillReal()).toBe(result !== "emulated");
	};
}

async function inAutoMode(action: () => Promise<void>) {
	const forced = process.env.CERALIVE_DEVICE_TYPE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	try {
		await onRealDevice(async () => {
			await start(pairs(G1));
			await attach();
			await action();
		});
	} finally {
		if (forced !== undefined) process.env.CERALIVE_DEVICE_TYPE = forced;
	}
}

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
