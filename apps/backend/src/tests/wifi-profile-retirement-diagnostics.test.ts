import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import * as exec from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import * as nm from "../modules/network/network-manager.ts";
import { readNmProfileInstance } from "../modules/network/network-manager-profile-instance.ts";
import { readNmVersionId } from "../modules/network/network-manager-profile-write.ts";
import * as secret from "../modules/network/network-manager-secret.ts";
import {
	getPendingHotspotCreationInstance,
	recordHotspotProfileCreation,
} from "../modules/wifi/hotspot-credentials.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { observeHotspotProfile } from "../modules/wifi/wifi-hotspot-profile-observation.ts";
import {
	type HotspotProfileEvidence,
	runHotspotProfileOperation,
} from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { hotspotBindingFields } from "../modules/wifi/wifi-hotspot-types.ts";
import { nmcliFieldNames } from "./helpers/nmcli-field-output.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

const readFields = nm.nmConnGetFields;

for (const scenario of [
	"before-up",
	"after-up",
	"after-down",
	"after-delete",
	"file-changed-during-read",
	"file-vanished",
	"run-changed-during-read",
	"path-changed-during-read",
	"fields-unreadable",
	"modify-success-foreign",
	"modify-failure-changed",
	"modify-fd-vanished",
	"modify-noop-race",
	"modify-record-refused",
	"observation-mismatch",
	"observation-unreadable",
	"observation-absent",
	"producer-submitted-mismatch",
	"quiet-success",
	"quiet-failure",
	"quiet-noop",
	"quiet-delete",
	"quiet-up",
	"quiet-down",
	"quiet-offline-failure",
] as const) {
	test(`authority retirement diagnostics: ${scenario}`, async () => {
		const f = await firstAp();
		f.nm.version("1.52.1");
		try {
			expect((await f.start()).success).toBe(true);
			const uuid = f.created();
			const expected = getPendingHotspotCreationInstance(MAC);
			if (!uuid || !expected)
				throw new Error("Missing diagnostic fixture receipt");
			if (scenario === "producer-submitted-mismatch")
				await settlePending("wlan0", true);
			const warnings: unknown[][] = [];
			spyOn(logger, "warn").mockImplementation(
				(message: unknown, ...meta: unknown[]) => {
					warnings.push([message, ...meta]);
					return logger;
				},
			);
			if (scenario === "before-up" || scenario === "observation-mismatch")
				f.replace(uuid, f.secret, false);
			if (scenario === "file-vanished") rmSync(f.nm.files.filename(uuid));
			if (scenario === "observation-absent") {
				f.profiles.delete(uuid);
				rmSync(f.nm.files.filename(uuid));
			}
			if (scenario.endsWith("-during-read")) {
				let once = true;
				spyOn(nm, "nmConnGetFields").mockImplementation(async (id, fields) => {
					const result = await readFields(id, fields);
					if (id === uuid && once) {
						once = false;
						if (scenario === "file-changed-during-read") f.nm.files.write(uuid);
						if (scenario === "run-changed-during-read") f.nm.restart(true);
						if (scenario === "path-changed-during-read")
							f.replace(uuid, "First AP");
					}
					return result;
				});
			}
			if (
				scenario === "fields-unreadable" ||
				scenario === "observation-unreadable"
			) {
				const boundary = spyOn(exec, "execFileP").getMockImplementation();
				if (!boundary) throw new Error("Missing diagnostic NM boundary");
				spyOn(exec, "execFileP").mockImplementation(
					async (binary, args, options) => {
						if (nmcliFieldNames(args ?? []).length > 0)
							throw new Error(`Private command argv and PSK ${f.secret}`);
						return boundary(binary, args, options);
					},
				);
			}
			if (scenario === "quiet-offline-failure")
				spyOn(secret, "serializeNmProfileModify").mockRejectedValue(
					new Error(f.secret),
				);
			const versionBefore =
				scenario === "quiet-up" || scenario === "quiet-down"
					? await readNmVersionId(expected.path)
					: undefined;
			let evidence: HotspotProfileEvidence | undefined;
			if (scenario === "modify-record-refused")
				evidence = {
					instance: expected,
					owner: MAC,
					readProfileInstance: readNmProfileInstance,
					recordCreation: () => false,
				};
			if (
				scenario === "modify-fd-vanished" ||
				scenario === "modify-noop-race"
			) {
				let reads = 0;
				evidence = {
					instance: expected,
					owner: MAC,
					readProfileInstance: async (id, fields, trace) => {
						reads++;
						if (reads === 2 && scenario === "modify-noop-race")
							f.replace(uuid, f.secret, false);
						const value = await readNmProfileInstance(id, fields, trace);
						if (reads === 1 && scenario === "modify-fd-vanished" && value?.file)
							rmSync(value.file.filename);
						return value;
					},
				};
			}
			let dispatched = false;
			const modifying =
				scenario.startsWith("modify-") ||
				(scenario.startsWith("quiet-") &&
					scenario !== "quiet-delete" &&
					scenario !== "quiet-up" &&
					scenario !== "quiet-down");
			const value = f.settings.get(uuid)?.["connection.autoconnect"] ?? "no";
			const delta = {
				"connection.autoconnect":
					scenario === "quiet-noop" || scenario === "modify-noop-race"
						? value
						: value === "yes"
							? "no"
							: "yes",
			};
			const result = scenario.startsWith("observation-")
				? { checked: (await observeHotspotProfile(uuid)).kind === "read" }
				: scenario === "producer-submitted-mismatch"
					? await (async () => {
							f.faults.afterAdd = async () => {
								const generated = f.created();
								if (generated) f.replace(generated, f.secret, false);
							};
							const created = await nm.nmApConnAdd(
								"wlan0",
								{
									name: "Submitted diagnostic profile",
									password: f.secret,
								},
								hotspotBindingFields(MAC),
								(id, instance) =>
									recordHotspotProfileCreation(MAC, id, instance),
							);
							return { checked: created !== undefined };
						})()
					: modifying
						? await runHotspotProfileOperation(
								{
									uuid,
									kind: "modify",
									fields: delta,
									run: async (fields) => {
										dispatched = true;
										if (scenario === "quiet-failure") return false;
										const written = await f.deps.nmConnSetFields(uuid, fields);
										if (scenario === "modify-success-foreign") {
											const settings = f.settings.get(uuid);
											if (settings) settings["802-11-wireless.ssid"] = f.secret;
											f.nm.files.write(uuid);
										}
										return scenario === "modify-failure-changed"
											? false
											: written;
									},
								},
								evidence,
							)
						: await runHotspotProfileOperation({
								uuid,
								kind:
									scenario === "after-down" || scenario === "quiet-down"
										? "down"
										: scenario === "after-delete" || scenario === "quiet-delete"
											? "delete"
											: "up",
								run: async () => {
									dispatched = true;
									if (scenario === "quiet-delete")
										return f.deps.nmConnDelete(uuid);
									if (scenario === "quiet-up")
										return f.deps.nmConnect(uuid, 30);
									if (scenario === "quiet-down") {
										const down = await f.deps.nmDisconnect(
											uuid,
											f.nm.activePath(),
											expected.runId,
											"wlan0",
										);
										f.nm.bumpVersion(uuid);
										f.nm.bumpVersion(uuid);
										return down;
									}
									if (scenario === "after-delete") {
										const deleted = await f.deps.nmConnDelete(uuid);
										f.profiles.add(uuid);
										f.replace(uuid, f.secret);
										return deleted;
									}
									if (scenario === "after-down") {
										const down = await f.deps.nmDisconnect(
											uuid,
											f.nm.activePath(),
											expected.runId,
											"wlan0",
										);
										f.replace(uuid, f.secret, false);
										return down;
									}
									if (scenario === "after-up") {
										const up = await f.deps.nmConnect(uuid, 30);
										f.replace(uuid, f.secret, false);
										return up;
									}
									return true;
								},
							});
			const retired = !scenario.startsWith("quiet-");
			expect(warnings).toHaveLength(retired ? 1 : 0);
			expect(JSON.stringify(warnings)).not.toContain(f.secret);
			if (scenario === "quiet-up" || scenario === "quiet-down") {
				if (versionBefore === undefined || versionBefore === null)
					throw new Error("Missing modern NM version receipt");
				expect(await readNmVersionId(expected.path)).toBe(versionBefore + 2n);
				expect(result.checked).toBe(true);
			}
			if (retired) {
				expect(result.checked).toBe(false);
				expect(warnings[0]?.[0]).toBe("Wi-Fi profile authority retired");
				expect(warnings[0]?.[1]).toMatchObject({
					exit: expect.any(String),
					fileReceiptMissing: expect.any(Boolean),
					stats: { before: expect.any(Object), after: expect.any(Object) },
					versionId:
						scenario === "observation-absent" ? null : expect.any(String),
				});
				const payload = warnings[0]?.[1];
				if (!payload || typeof payload !== "object")
					throw new Error("Missing warning projection");
				expect(Object.keys(payload).sort()).toEqual(
					[
						"exit",
						"readExit",
						"changedFields",
						"fieldComparisonAvailable",
						"comparedFieldCount",
						"fieldComparisonScope",
						"requestedFields",
						"fileReceiptMissing",
						"fileReceiptReason",
						"stats",
						"pathChanged",
						"runChanged",
						"filenameChanged",
						"versionId",
					].sort(),
				);
				expect(JSON.stringify(payload)).not.toContain('"fieldDigests"');
				expect(JSON.stringify(payload)).not.toContain('"fingerprint"');
				expect(JSON.stringify(payload)).not.toContain('"filename":');
				expect(JSON.stringify(payload)).not.toContain('"argv"');
				if (scenario !== "producer-submitted-mismatch")
					expect(warnings[0]?.[1]).toMatchObject({
						stats: {
							before: {
								first: {
									dev: expect.any(String),
									inode: expect.any(String),
									size: expect.any(String),
									mtime_ns: expect.any(String),
									ctime_ns: expect.any(String),
								},
							},
						},
					});
				if (
					scenario === "before-up" ||
					scenario === "after-up" ||
					scenario === "modify-success-foreign"
				)
					expect(warnings[0]?.[1]).toMatchObject({
						changedFields: ["802-11-wireless.ssid"],
					});
				if (scenario === "file-changed-during-read")
					expect(warnings[0]?.[1]).toMatchObject({
						fileReceiptMissing: true,
						fileReceiptReason: "changed-between-reads",
					});
				if (scenario === "file-vanished")
					expect(warnings[0]?.[1]).toMatchObject({
						fileReceiptMissing: true,
						fileReceiptReason: "vanished",
					});
				if (scenario === "run-changed-during-read")
					expect(warnings[0]?.[1]).toMatchObject({ runChanged: true });
				if (scenario === "path-changed-during-read")
					expect(warnings[0]?.[1]).toMatchObject({ pathChanged: true });
				if (!scenario.startsWith("after-") && !modifying)
					expect(dispatched).toBe(false);
				if (
					scenario === "modify-noop-race" ||
					scenario === "modify-fd-vanished"
				)
					expect(dispatched).toBe(false);
			}
		} finally {
			await f.restore();
		}
	});
}
