import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { resolveWifiBinding } from "../modules/wifi/wifi-binding.ts";
import * as devlist from "../modules/wifi/wifi-device-list.ts";
import {
	type BaseWifiInterface,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { wifiOperationGuard } from "../modules/wifi/wifi-operation-binding.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../modules/wifi/wifi-radio-publication.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

const MAC = "dc:a6:32:aa:bb:c0";

async function withBusyRadio(
	run: (radio: {
		row: BaseWifiInterface;
		token: string;
		guard: ReturnType<typeof wifiOperationGuard>;
	}) => Promise<void>,
) {
	const fixture = await wifiFrameFixture();
	try {
		const { row, before: token } = fixture;
		if (!token) throw new Error("expected an initial radio token");
		spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:connected:test-ap"]);
		spyOn(devlist, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
		spyOn(nm, "nmConnGetFields").mockResolvedValue(["ap"]);
		spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("unexpected native command");
		});
		const held = await withWifiAdapterLock(
			wifiAdapterLockKey(MAC),
			async () => {
				const admitted = await resolveWifiBinding(row.id, token, "mode");
				if (!admitted.success || !admitted.operation)
					throw new Error("expected a bound operation before refresh");
				const guard = wifiOperationGuard(admitted.operation);
				expect(await guard.permit()).toBe(true);
				await run({ row, token, guard });
			},
		);
		expect(held.success).toBe(true);
	} finally {
		stopWifiUpdateLoopForTest();
		await fixture.restore();
	}
}

test("a busy refresh keeps the same radio's operation but withholds fresh admission", async () => {
	await withBusyRadio(async ({ row, token, guard }) => {
		const before = wifiRadioIdentity.publishedObservation;
		await wifiUpdateDevices();
		const current = wifiRadioIdentity.publishedObservation;
		expect(current).toBeGreaterThan(before);
		expect(await guard.permit()).toBe(true);
		expect(
			projectWifiRadioIncarnation(
				row,
				wifiRadioIdentity.state.rows.get(row.ifname),
			),
		).toBeUndefined();
		expect(await resolveWifiBinding(row.id, token, "mode")).toEqual({
			success: false,
			error: "radio-changed",
			reason: "current-unobserved",
		});

		wifiRadioIdentity.associateRows([row], current);
		expect(await resolveWifiBinding(row.id, token, "mode")).toMatchObject({
			success: true,
			operation: { token },
		});
	});
});

test("a busy refresh does not carry the row onto a same-name replacement", async () => {
	await withBusyRadio(async ({ row, token, guard }) => {
		const readText = spyOn(radioIdentityReaders, "readText");
		const previousRead = readText.getMockImplementation();
		if (!previousRead) throw new Error("expected fixture sysfs reader");
		readText.mockImplementation(async (path) =>
			path.endsWith("/ifindex") ? "20" : previousRead(path),
		);

		await wifiUpdateDevices();
		const current = wifiRadioIdentity.state.rows.get(row.ifname);
		expect(current?.lifetime?.ifindex).toBe(20);
		expect(current?.incarnation).not.toBe(token);
		expect(current?.row).toBeUndefined();
		expect(await guard.permit()).toBe(false);
	});
});

test("a late healthy sample cannot restore the row retired by a busy unavailable refresh", async () => {
	await withBusyRadio(async ({ row, token, guard }) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const readDevicePath = radioIdentityReaders.readDevicePath;
		if (!readDevicePath) throw new Error("expected fixture device path reader");
		const path = await readDevicePath(row.ifname);
		spyOn(radioIdentityReaders, "readDevicePath").mockImplementationOnce(
			async () => {
				entered.resolve();
				await release.promise;
				return path;
			},
		);
		const older = wifiRadioIdentity.captureObservation();
		const stale = wifiRadioIdentity.discover(
			[{ ifname: row.ifname, row }],
			older,
		);
		try {
			await Promise.race([
				entered.promise,
				stale.then(() => {
					throw new Error("old sample did not park in the lifetime bracket");
				}),
			]);
			spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:unavailable:"]);
			await wifiUpdateDevices();
			const current = wifiRadioIdentity.state.rows.get(row.ifname);
			expect(current?.degradedReason).toBe("unavailable");
			expect(current?.incarnation).not.toBe(token);
			expect(current?.row).toBeUndefined();
			expect(await guard.permit()).toBe(false);

			release.resolve();
			await stale;
			const after = wifiRadioIdentity.state.rows.get(row.ifname);
			expect(after?.incarnation).toBe(current?.incarnation);
			expect(after?.degradedReason).toBe("unavailable");
			expect(after?.row).toBeUndefined();
			expect(projectWifiRadioIncarnation(row, after)).toBeUndefined();
		} finally {
			release.resolve();
			await stale;
		}
	});
});
