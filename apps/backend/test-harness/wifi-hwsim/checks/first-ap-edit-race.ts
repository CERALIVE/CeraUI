import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	nmApConnAdd,
	nmConnDelete,
	nmConnSetFields,
	nmDeviceProp,
} from "../../../src/modules/network/network-manager.ts";
import { readNmProfileInstance } from "../../../src/modules/network/network-manager-profile-instance.ts";
import { readNmVersionId } from "../../../src/modules/network/network-manager-profile-write.ts";
import { getBootReadiness } from "../../../src/modules/system/readiness.ts";
import {
	getPendingHotspotCreation,
	recordHotspotProfileCreation,
} from "../../../src/modules/wifi/hotspot-credentials.ts";
import { runHotspotProfileOperation } from "../../../src/modules/wifi/wifi-hotspot-profile-operation.ts";
import { hotspotBindingFields } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import type { FirstApCheckpoint } from "./first-ap-diagnostics.ts";
import type { NativeNmcliProbe } from "./first-ap-nmcli-shim.ts";

export async function nativeEditRaceCases(
	target: {
		readonly owner: string;
		readonly ifname: string;
		readonly password: string;
	},
	probe: NativeNmcliProbe,
	checkpoint: FirstApCheckpoint,
): Promise<void> {
	checkpoint("modify.parity");
	const create = async () => {
		const uuid = await nmApConnAdd(
			target.ifname,
			{
				name: `NativeFence-${crypto.randomUUID().slice(0, 8)}`,
				password: target.password,
			},
			hotspotBindingFields(target.owner),
			(id, instance) =>
				recordHotspotProfileCreation(target.owner, id, instance),
		);
		assert(uuid, "Native fence profile add failed");
		return uuid;
	};
	const modify = async (
		uuid: string,
		fields: Readonly<Record<string, string>>,
	) =>
		runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields,
			run: (delta) => nmConnSetFields(uuid, delta),
		});
	const control = await create();
	const deltas: readonly Readonly<Record<string, string>>[] = [
		{ "connection.autoconnect": "yes" },
		{ "connection.autoconnect": "no" },
		{ "connection.interface-name": target.ifname },
		{
			"connection.interface-name": "",
			"802-11-wireless.mac-address": target.owner,
		},
		{ "802-11-wireless.band": "bg", "802-11-wireless.channel": "6" },
		{ "802-11-wireless-security.psk": `${target.password.slice(0, -1)}x` },
		{ "802-11-wireless-security.psk": target.password },
	];
	for (const fields of deltas) {
		const result = await modify(control, fields);
		assert(
			result.success && result.checked,
			"Native writer/offline byte parity failed",
		);
	}
	assert(
		(
			await runHotspotProfileOperation({
				uuid: control,
				kind: "delete",
				run: () => nmConnDelete(control),
			})
		).success,
	);
	for (const schedule of ["restore", "atomic", "before", "version"] as const) {
		checkpoint("modify.foreign");
		const uuid = await create();
		assert((await modify(uuid, { "connection.autoconnect": "yes" })).success);
		const before = await readNmProfileInstance(uuid);
		assert(before?.file, "Native pre-write file missing");
		const versionBefore =
			schedule === "version" ? await readNmVersionId(before.path) : null;
		await probe.schedule(uuid, before.file.filename, schedule);
		const result = await modify(uuid, { "connection.autoconnect": "no" });
		if (schedule === "version") {
			assert(
				result.success && result.checked,
				"Activation alone retired valid file authority",
			);
			const active = await nmDeviceProp(
				target.ifname,
				"GENERAL.STATE,GENERAL.CON-UUID",
			);
			assert.equal(Number.parseInt(active?.[0] ?? "", 10), 100);
			assert.equal(active?.[1], uuid);
			assert.equal(getPendingHotspotCreation(target.owner), uuid);
			console.log("first-ap: activation VersionId is diagnostic only", {
				before: versionBefore?.toString() ?? null,
				after: (await readNmVersionId(before.path))?.toString() ?? null,
			});
			assert(
				(
					await runHotspotProfileOperation({
						uuid,
						kind: "delete",
						run: () => nmConnDelete(uuid),
					})
				).success,
			);
			continue;
		}
		assert.equal(result.checked, false, "Native foreign bytes were adopted");
		assert.equal(result.success, false);
		const foreign = await probe.foreign();
		assert((await readFile(before.file.filename)).equals(foreign));
		assert.equal(getPendingHotspotCreation(target.owner), undefined);
		assert(
			getBootReadiness().degradedSubsystems.includes(
				`wifi-hotspot-authority:${target.owner}`,
			),
		);
		const at = (await probe.events()).length;
		const again = await runHotspotProfileOperation(
			{
				uuid,
				kind: "delete",
				run: () => nmConnDelete(uuid),
			},
			{
				instance: before,
				readProfileInstance: readNmProfileInstance,
				owner: target.owner,
			},
		);
		assert.equal(again.success, false);
		assert((await readFile(before.file.filename)).equals(foreign));
		assert.equal(
			(await probe.events())
				.slice(at)
				.filter((event) => event.uuid === uuid && event.kind !== "read").length,
			0,
		);
	}
	console.log(
		"first-ap: native serializer parity and foreign-write retirement passed",
	);
}
