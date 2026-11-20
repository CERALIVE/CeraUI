import { expect, test } from "bun:test";
import {
	lstat,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type NmProfileInstance,
	readNmProfileInstance,
} from "../modules/network/network-manager-profile-instance.ts";
import { getPendingHotspotCreationInstance } from "../modules/wifi/hotspot-credentials.ts";
import { runHotspotProfileOperation } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { classifyHotspotProfileReadback } from "../modules/wifi/wifi-hotspot-profile-readback.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

async function fileInstance(filename: string): Promise<NmProfileInstance> {
	const stat = await lstat(filename, { bigint: true });
	return {
		runId: "captured-run",
		path: "/org/freedesktop/NetworkManager/Settings/1",
		fingerprint: "selected-settings",
		file: {
			filename,
			device: String(stat.dev),
			inode: String(stat.ino),
			ctime: String(stat.ctimeNs),
		},
	};
}

for (const fixture of ["priority", "hybrid"]) {
	for (const edit of [
		"none",
		"unknown-setting",
		"wrong-timestamp",
		"wrong-group",
		"duplicate-group",
		"duplicate-timestamp",
		"policy",
		"held-inode",
		"missing-observation",
		"wrong-observation",
		"out-of-range",
	] as const) {
		test(`captured R22 ${fixture} modify accepts only the observed daemon timestamp, edit=${edit}`, async () => {
			const captured = await readFile(
				new URL(
					`./fixtures/wifi/r22-${fixture}-timestamp.nmconnection`,
					import.meta.url,
				),
				"utf8",
			);
			const timestamp = /^timestamp=(\d+)$/m.exec(captured)?.[1];
			if (!timestamp) throw new Error("Missing recorded NM timestamp");
			// Only post-write bytes were retained. These are explicit reconstructed controls.
			const predicted = captured.replace(/^timestamp=\d+\n/m, "");
			const original = predicted.replace(
				fixture === "priority"
					? /^autoconnect-priority=999\n/m
					: /^autoconnect=false\n/m,
				"",
			);
			const dir = await mkdtemp(join(tmpdir(), "wifi-r22-timestamp-"));
			const filename = join(dir, "profile.nmconnection");
			await writeFile(filename, original, { mode: 0o600 });
			const held = {
				handle: await open(filename, "r+"),
				bytes: Buffer.from(original),
			};
			try {
				const before = await fileInstance(filename);
				let next = captured;
				if (edit === "unknown-setting") next += "\n[foreign]\nvalue=changed\n";
				if (edit === "wrong-timestamp")
					next = next.replace(timestamp, "1794966000");
				if (edit === "wrong-group")
					next = next
						.replace(/^timestamp=\d+\n/m, "")
						.replace("[wifi]\n", `[wifi]\ntimestamp=${timestamp}\n`);
				if (edit === "duplicate-group")
					next += `\n[connection]\ntimestamp=${timestamp}\n`;
				if (edit === "duplicate-timestamp")
					next = next.replace(
						`timestamp=${timestamp}\n`,
						`timestamp=${timestamp}\ntimestamp=${timestamp}\n`,
					);
				if (edit === "policy")
					next = next.replace(
						"autoconnect-priority=999",
						"autoconnect-priority=998",
					);
				if (edit === "out-of-range")
					next = next.replace(timestamp, "18446744073709551616");
				await writeFile(`${filename}.next`, next, { mode: 0o600 });
				await rename(`${filename}.next`, filename);
				if (edit === "held-inode")
					await held.handle.writeFile("\n# foreign inode edit\n");
				const after = await fileInstance(filename);
				const result = await classifyHotspotProfileReadback(
					{
						kind: "modify",
						before,
						held,
						predicted: Buffer.from(predicted),
						acknowledged: true,
						fields:
							fixture === "priority"
								? { "connection.autoconnect-priority": "999" }
								: { "connection.autoconnect": "no" },
					},
					after,
					edit === "missing-observation"
						? {}
						: {
								activationTimestamp:
									edit === "wrong-observation"
										? "1794966000"
										: edit === "out-of-range"
											? "18446744073709551616"
											: timestamp,
							},
				);
				expect(result.checked).toBe(edit === "none");
				expect(result.exit).toBe(
					edit === "none"
						? undefined
						: edit === "held-inode"
							? "modify-prewrite-inode-edited"
							: "modify-prediction-mismatch",
				);
				if (edit === "none") expect(result.instance).toEqual(after);
			} finally {
				await held.handle.close();
				await rm(dir, { recursive: true });
			}
		});
	}
}

test("an explicitly requested timestamp must match the request rather than a different daemon value", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		const settings = uuid ? f.settings.get(uuid) : undefined;
		if (!uuid || !settings) throw new Error("Missing created profile");
		f.faults.afterModify = () => {
			settings["connection.timestamp"] = "1794966000";
			f.nm.files.write(uuid);
		};
		const result = await runHotspotProfileOperation({
			kind: "modify",
			uuid,
			fields: { "connection.timestamp": "1794966929" },
			run: (fields) => f.deps.nmConnSetFields(uuid, fields),
		});
		expect(result.success).toBe(false);
		expect(result.checked).toBe(false);
		expect(getPendingHotspotCreationInstance(MAC)).toBeUndefined();
		expect(f.profiles.has(uuid)).toBe(true);
	} finally {
		await f.restore();
	}
});

for (const field of [
	"connection.autoconnect-priority",
	"connection.autoconnect",
]) {
	test(`owned ${field} normalization advances the creation receipt when NM persists its timestamp`, async () => {
		const f = await firstAp();
		try {
			expect((await f.start()).success).toBe(true);
			const uuid = f.created();
			const settings = uuid ? f.settings.get(uuid) : undefined;
			if (!uuid || !settings) throw new Error("Missing created profile");
			if (field === "connection.autoconnect") {
				const armed = await runHotspotProfileOperation({
					kind: "modify",
					uuid,
					fields: { "connection.autoconnect": "yes" },
					run: (fields) => f.deps.nmConnSetFields(uuid, fields),
				});
				expect(armed.success).toBe(true);
			}
			const before = getPendingHotspotCreationInstance(MAC);
			f.faults.afterModify = () => {
				settings["connection.timestamp"] = "1794966929";
				f.nm.files.write(uuid);
			};
			const result = await runHotspotProfileOperation({
				kind: "modify",
				uuid,
				fields: { [field]: field.endsWith("priority") ? "998" : "no" },
				run: (fields) => f.deps.nmConnSetFields(uuid, fields),
			});
			expect(result.success).toBe(true);
			expect(result.checked).toBe(true);
			expect(result.instance?.file?.inode).not.toBe(before?.file?.inode);
			expect(getPendingHotspotCreationInstance(MAC)).toEqual(
				result.instance ?? undefined,
			);
			expect(
				await readNmProfileInstance(uuid, {
					"connection.timestamp": "1794966929",
				}),
			).toEqual(result.instance);
			expect(f.active()).toBe(uuid);
		} finally {
			await f.restore();
		}
	});
}
