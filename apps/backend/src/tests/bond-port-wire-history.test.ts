import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateMockState } from "../mocks/mock-service.ts";
import { getConfig, saveConfig } from "../modules/config.ts";
import {
	defaultRouterCellularScanDeps,
	getUsbPhysicalDescriptor,
	refreshUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { buildMsg } from "../rpc/compat.ts";
import {
	a,
	addUplinks,
	at,
	b,
	configure,
	digest,
	directory,
	file,
	first,
	G1,
	G2,
	g1,
	installBondPortFixture,
	onRealDevice,
	portId,
	scan,
	second,
	start,
} from "./helpers/bond-port-record-fixture.ts";
import { constructedTwinDeps } from "./helpers/constructed-usb-twins.ts";

installBondPortFixture();

test("persisting newly seen shared serial history does not restore stale bond preferences", async () => {
	await start({ bond_opt_out: { [G1]: true } });
	const newTwins = [at(a, "PORT-RECORD-NEW"), at(b, "PORT-RECORD-NEW")];
	const replacement = { bond_opt_out: { [G2]: true }, max_br: 4321 };
	await writeFile(file, JSON.stringify(replacement));
	await refreshUsbNetMarkers([first, second], {
		...defaultRouterCellularScanDeps,
		...constructedTwinDeps(newTwins),
	});
	expect(await Bun.file(file).json()).toEqual({
		...replacement,
		usb_serial_shared: [digest("413c", "PORT-RECORD-NEW")],
	});
});

test("a newly attached twin publishes on retry after a history write fails", async () => {
	await start({});
	await scan(at(a, g1));
	expect(getUsbPhysicalDescriptor(first)).toBeDefined();
	// Block the real atomic writer's temporary file, even when running as root.
	await mkdir(join(directory, `.config.json.${process.pid}.tmp`));
	await scan(at(a, g1), at(b, g1));
	expect(getUsbPhysicalDescriptor(second)).toBeUndefined();
	await scan(at(a, g1), at(b, g1));
	expect(getUsbPhysicalDescriptor(second)).toBeDefined();
	expect(await Bun.file(file).text()).toBe("{}");
});

test.each(["", "PORT-WIRE-UNIQUE"])(
	"real USB OFF with serial %j leaves the config frame in main's format",
	async (serial) => {
		await onRealDevice(async () => {
			await start({});
			await scan(at(b, serial));
			addUplinks();
			const expected = {
				...getConfig(),
				bond_opt_out: { [portId(b)]: true },
			};
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(buildMsg("config", getConfig())).toBe(
				JSON.stringify({ config: expected }),
			);
		});
	},
);

test.each([
	["mock", "production", "true", undefined, undefined, "real", false],
	["overlay", "production", "true", undefined, undefined, "real", true],
	["hwsim", "production", undefined, undefined, "/fixture", "real", false],
	[
		"emulated",
		"production",
		undefined,
		undefined,
		undefined,
		"emulated",
		false,
	],
	[
		"scenario",
		"production",
		undefined,
		"multi-modem-wifi",
		undefined,
		"real",
		false,
	],
	["test", "test", undefined, undefined, undefined, "real", false],
] as const)(
	"serial-less non-twin OFF/ON restores the exact saved bytes in %s",
	async (_mode, node, mock, scenario, hwsim, device, overlay) => {
		const env = {
			NODE_ENV: node,
			MOCK_MODE: mock,
			MOCK_SCENARIO: scenario,
			HWSIM_REPO: hwsim,
			CERALIVE_DEVICE_TYPE: device,
		};
		const before = Object.keys(env).map(
			(key) => [key, process.env[key]] as const,
		);
		try {
			for (const [key, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			updateMockState({ initialized: overlay, netifConfigs: new Map() });
			await start({});
			saveConfig();
			const initial = await Bun.file(file).text();
			await scan(at(b, ""));
			addUplinks();
			expect(await configure(second, "198.51.100.2", false)).toMatchObject({
				success: true,
				applied: { enabled: false },
			});
			expect(await configure(second, "198.51.100.2", true)).toMatchObject({
				success: true,
				applied: { enabled: true },
			});
			expect(await Bun.file(file).text()).toBe(initial);
		} finally {
			updateMockState({ initialized: false, netifConfigs: new Map() });
			for (const [key, value] of before) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	},
);
