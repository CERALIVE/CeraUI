import { expect } from "bun:test";
import { setBondDisableGuardContext } from "../../modules/network/network-interfaces.ts";
import { observeRealDeviceAtBoot } from "../../modules/system/device-detection.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	first,
	G1,
	g1,
	onRealDevice,
	pairs,
	reload,
	scan,
	second,
	senders,
	start,
} from "./bond-port-record-fixture.ts";
import { clearBondNetworkFixture } from "./bond-toggle-fixture.ts";

if (a === undefined || b === undefined) throw new Error("Expected two ports");
const modems = [at(a, g1), at(b, g1)] as const;
const paths = { first, second } as const;
type Twin = keyof typeof paths;

async function attach(firstSerial = g1, secondSerial = g1) {
	clearBondNetworkFixture();
	await scan(at(modems[0], firstSerial), at(modems[1], secondSerial));
	addUplinks(first);
}

async function restart(firstSerial = g1, secondSerial = g1) {
	await reload();
	await attach(firstSerial, secondSerial);
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

export {
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
};
