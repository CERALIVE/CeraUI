import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../../../src/helpers/run.ts";
import { runEditSchedules } from "./first-ap-edit-race.ts";
import {
	profileFieldDiff,
	profileSerialization,
} from "./hybrid-observations.ts";

const uuids = {
	restore: "37735165-56f2-4df7-88c8-a79d010a85af",
	atomic: "c63aacec-9110-4a6e-86df-d4b130cc0304",
	before: "0cc479f8-bf10-4f8f-9b52-3442cedfaf56",
} as const;

test("R26 preserved first-AP profiles survive the hybrid baseline and cold reread", async () => {
	const root = await mkdtemp(join(tmpdir(), "first-ap-handoff-"));
	const pathFor = (uuid: string) => join(root, `Hotspot-${uuid}.nmconnection`);
	const files = new Map<string, string>();
	const live = new Map<string, string>();
	const load = async (uuid: string, filename: string) => {
		const text = await readFile(filename, "utf8");
		live.set(uuid, text.includes("\nautoconnect=false\n") ? "no" : "yes");
	};
	const snapshot = async () => {
		const settings = new Map<string, string>();
		for (const [uuid, filename] of files) {
			settings.set(
				uuid,
				profileSerialization(
					`connection.id:Hotspot\nconnection.autoconnect:${live.get(uuid)}`,
					await readFile(filename),
				),
			);
		}
		return settings;
	};
	let beforeSettle = new Map<string, string>();
	let deviceAuto = true;
	const nmcli = spyOn(runner, "run").mockImplementation(async (bin, args) => {
		expect(bin).toBe("nmcli");
		if (args.join(" ") === "device set wlan1 autoconnect no") {
			deviceAuto = false;
			return "";
		}
		if (args[0] === "connection" && args[1] === "load") {
			expect([...beforeSettle.keys()].sort()).toEqual(
				Object.values(uuids).sort(),
			);
			expect(deviceAuto).toBe(false);
			expect(args.slice(2).sort()).toEqual(
				[pathFor(uuids.restore), pathFor(uuids.atomic)].sort(),
			);
			for (const [uuid, filename] of files) {
				if (args.slice(2).includes(filename)) await load(uuid, filename);
			}
			return "";
		}
		if (
			args.slice(0, -1).join(" ") ===
			"-g connection.autoconnect connection show uuid"
		)
			return `${live.get(args.at(-1) ?? "")}\n`;
		throw new Error(`Unexpected replay command: ${args.join(" ")}`);
	});
	try {
		await runEditSchedules("wlan1", async (schedule) => {
			if (schedule === "version") {
				beforeSettle = await snapshot();
				return;
			}
			const uuid = uuids[schedule];
			const filename = pathFor(uuid);
			// State at refused delete: NM accepted "no"; only the before schedule kept that file.
			const foreign = Buffer.from(
				`[connection]\nid=Hotspot\nuuid=${uuid}\n${schedule === "before" ? "autoconnect=false\n" : ""}\n[wifi]\nmode=ap\n`,
			);
			await writeFile(filename, foreign);
			files.set(uuid, filename);
			live.set(uuid, "no");
			return { uuid, filename, foreign };
		});
		const baseline = await snapshot();
		for (const [uuid, filename] of files) await load(uuid, filename);
		const rebooted = await snapshot();
		expect(profileFieldDiff(beforeSettle, rebooted)).toEqual([
			`${uuids.restore} (Hotspot): connection.autoconnect`,
			`${uuids.atomic} (Hotspot): connection.autoconnect`,
		]);
		expect(profileFieldDiff(baseline, rebooted)).toEqual([]);
	} finally {
		nmcli.mockRestore();
		await rm(root, { recursive: true });
	}
});
