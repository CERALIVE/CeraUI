import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import { resolveModemNmDeviceForConnection } from "../modules/modems/modem-nm-device.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import capture from "./fixtures/real-device/nm-1.52.1-twin-profile-capture.json";
import { assertNmDeviceShowFields } from "./helpers/nm-device-show-fixture.ts";

// This real capture has no overlap; the constructed replay retains that case.
const profiles = [
	["cdc-wdm0", "00000000-0000-4000-8000-000000000006"],
	["cdc-wdm1", "00000000-0000-4000-8000-000000000004"],
] as const;

let clearActive = false;
let run: ReturnType<typeof spyOn<typeof runner, "run">>;

beforeEach(() => {
	clearActive = false;
	run = spyOn(runner, "run").mockImplementation(async (binary, args) => {
		expect(binary).toBe("nmcli");
		if (args.includes("DEVICE,TYPE")) {
			return capture.general
				.trimEnd()
				.split("\n\n")
				.map((block) => {
					const fields = block.split("\n");
					return `${fields[0]?.slice("GENERAL.DEVICE:".length)}:${fields[2]?.slice("GENERAL.TYPE:".length)}`;
				})
				.join("\n");
		}
		const fields = args[args.indexOf("--get-values") + 1];
		if (fields === undefined) throw new Error("missing device show fields");
		assertNmDeviceShowFields(fields);
		const device = capture.devices.find(
			(entry) => entry.device === args.at(-1),
		);
		if (device === undefined) throw new Error("unexpected device");
		if (fields === "GENERAL.CON-UUID") return clearActive ? "" : device.active;
		if (fields === "CONNECTIONS.AVAILABLE-CONNECTIONS") {
			expect(args.slice(0, 2)).toEqual(["--mode", "multiline"]);
			return device.multiline;
		}
		throw new Error(`unexpected fields: ${fields}`);
	});
});

afterEach(() => run.mockRestore());

test("real capture has one disjoint profile per gsm device and matching output forms", () => {
	const available = capture.devices.map((device) => {
		const [active, ...tabular] = device.tabular.trimEnd().split("\n");
		const multiline = device.multiline
			.trimEnd()
			.split("\n")
			.map((line) => line.slice(line.indexOf(":") + 1));
		expect(active).toBe(device.active.trim());
		expect(tabular).toEqual(multiline);
		return multiline;
	});
	expect(available).toEqual([
		["00000000-0000-4000-8000-000000000006 | REDACTED_006"],
		["00000000-0000-4000-8000-000000000004 | REDACTED_004"],
	]);
	expect(
		available[0]?.filter((entry) => available[1]?.includes(entry)),
	).toEqual([]);
	expect(capture.devices.map((device) => device.active.trim())).toEqual([
		"",
		"00000000-0000-4000-8000-000000000004",
	]);
	expect(capture.connections.trimEnd().split("\n")).toEqual([
		"REDACTED_004:00000000-0000-4000-8000-000000000004:gsm:cdc-wdm1",
		"REDACTED_006:00000000-0000-4000-8000-000000000006:gsm:",
	]);
});

test.each(profiles)(
	"real capture resolves the saved profile on %s",
	async (device, uuid) => {
		await withDeviceType("real", async () => {
			await expect(resolveModemNmDeviceForConnection(uuid)).resolves.toBe(
				device,
			);
		});
	},
);

test.each(profiles)(
	"real captured availability resolves %s when active connections are cleared",
	async (device, uuid) => {
		clearActive = true;
		await withDeviceType("real", async () => {
			await expect(resolveModemNmDeviceForConnection(uuid)).resolves.toBe(
				device,
			);
		});
	},
);
