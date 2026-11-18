import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { HotspotToggleOutput } from "@ceraui/rpc/schemas";
import { getConfig } from "../../../src/modules/config.ts";
import { nmDeviceProp } from "../../../src/modules/network/network-manager.ts";
import {
	getHotspotCredentials,
	getPendingHotspotCreation,
	rememberHotspotCredentials,
} from "../../../src/modules/wifi/hotspot-credentials.ts";
import { removeWifiInterface } from "../../../src/modules/wifi/wifi-connections.ts";
import { wifiHotspotStart } from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotStop } from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import {
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
	terminateWifiDiscovery,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../../src/modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../../../src/modules/wifi/wifi-radio-observation.ts";
import { initSocketData } from "../../../src/rpc/context.ts";
import { addClient, removeClient } from "../../../src/rpc/events.ts";
import type { SocketData } from "../../../src/rpc/types.ts";
import type { FirstApCheckpoint } from "./first-ap-diagnostics.ts";
import type { NativeNmcliProbe } from "./first-ap-nmcli-shim.ts";
import {
	observeSavedProfileRadio,
	seedObservedRadioRow,
} from "./first-ap-radio.ts";
import { nativeRecoveryCase } from "./first-ap-recovery.ts";
import { nativeStartConfirmation } from "./native-terminal.ts";

/** Backend entry coverage; RPC transport/admission is covered by the RPC unit suites. */
export async function savedProfileBackendCycle(
	target: {
		readonly uuid: string;
		readonly ifname: string;
		readonly owner: string;
	},
	checkpoint: FirstApCheckpoint,
	probe: NativeNmcliProbe,
): Promise<void> {
	checkpoint("saved.setup");
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the isolated native VM");
	assert.equal(process.getuid?.(), 0, "Run as root inside the native VM");
	let id: number | undefined;
	let server: Bun.Server<SocketData> | undefined;
	let client: WebSocket | undefined;
	let openDeadline: ReturnType<typeof setTimeout> | undefined;
	let confirmationDeadline: ReturnType<typeof setTimeout> | undefined;
	let confirmation:
		| ReturnType<typeof Promise.withResolvers<HotspotToggleOutput | undefined>>
		| undefined;
	try {
		const permanent = (
			await readFile(
				`/sys/class/net/${target.ifname}/phy80211/macaddress`,
				"utf8",
			)
		)
			.trim()
			.toLowerCase();
		assert.equal(
			permanent,
			target.owner,
			"Native owner differs from the real radio",
		);
		const credentials = getHotspotCredentials(target.owner);
		assert(credentials, "Missing native profile owner");
		rememberHotspotCredentials(target.owner, {
			...credentials,
			conn: target.uuid,
		});
		getConfig().wifi_modes = {
			...getConfig().wifi_modes,
			[target.owner]: "hotspot",
		};
		const row = await seedObservedRadioRow({
			ifname: target.ifname,
			owner: target.owner,
			uuid: target.uuid,
			ssid: credentials.ssid,
			password: credentials.password,
		});
		id = row.id;
		checkpoint("saved.identity");
		await observeSavedProfileRadio(target.ifname);
		assert.equal(getMacAddressForWifiInterface(row.id), target.owner);
		await wifiRadioIdentity.discover([{ ifname: target.ifname, row }]);
		const identity = wifiRadioIdentity.state.rows.get(target.ifname);
		assert.equal(
			identity?.classification,
			"verified",
			"Native radio identity was not verified",
		);
		assert.equal(identity?.permanentMac, target.owner);
		assert.equal(identity?.row, row);
		process.stdout.write(
			"first-ap: saved-profile backend fixture has real verified radio identity; vendor/product remain unknown\n",
		);

		const ready = Promise.withResolvers<void>();
		server = Bun.serve<SocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, listener) {
				const data = initSocketData();
				data.isAuthenticated = true;
				if (listener.upgrade(request, { data })) return;
				return new Response("Native outcome observation requires WebSocket", {
					status: 400,
				});
			},
			websocket: {
				open(socket) {
					addClient(socket);
					ready.resolve();
				},
				message(socket) {
					socket.close(1003, "Outcome observer only");
				},
				close: removeClient,
			},
		});
		client = new WebSocket(`ws://127.0.0.1:${server.port}`);
		openDeadline = setTimeout(
			() => ready.reject(new Error("Native outcome observer timed out")),
			5000,
		);
		client.onmessage = (event) => {
			const terminal = nativeStartConfirmation(event.data, row.id);
			if (terminal) confirmation?.resolve(terminal);
		};
		await ready.promise;
		clearTimeout(openDeadline);

		const startConfirmed = async (phase: "saved.confirm" | "saved.restart") => {
			await observeSavedProfileRadio(target.ifname);
			const pending = Promise.withResolvers<HotspotToggleOutput | undefined>();
			confirmation = pending;
			confirmationDeadline = setTimeout(
				() => pending.resolve(undefined),
				60000,
			);
			const started = await wifiHotspotStart({ device: row.id });
			checkpoint(phase, started);
			assert(started.success, "Native backend saved Start failed");
			const confirmed = await pending.promise;
			checkpoint(phase, confirmed);
			assert(
				confirmed?.success,
				"Native backend saved Start did not publish confirmation",
			);
			clearTimeout(confirmationDeadline);
			confirmation = undefined;
			await observeSavedProfileRadio(target.ifname);
			assert.equal(getMacAddressForWifiInterface(row.id), target.owner);
			const state = await nmDeviceProp(
				target.ifname,
				"GENERAL.STATE,GENERAL.CON-UUID",
			);
			assert.equal(Number.parseInt(state?.[0] ?? "", 10), 100);
			assert.equal(state?.[1], target.uuid);
			assert.equal(row.hotspot.transition, undefined);
			assert.equal(row.conn, target.uuid);
			assert.equal(
				getHotspotCredentials(target.owner)?.conn,
				target.uuid,
				"Saved credential UUID binding changed",
			);
		};
		// NM restart may have left the autoconnect-off AP down: establish confirmed activity first.
		checkpoint("saved.confirm");
		await startConfirmed("saved.confirm");
		checkpoint("saved.stop");
		const stopped = await wifiHotspotStop({ device: row.id });
		checkpoint("saved.stop", stopped);
		assert(stopped.success, "Native backend Stop failed");
		const inactive = await nmDeviceProp(
			target.ifname,
			"GENERAL.STATE,GENERAL.CON-UUID",
		);
		assert(
			inactive?.[0] && inactive[1] !== target.uuid,
			"Backend Stop left its saved profile active",
		);
		checkpoint("saved.restart");
		await startConfirmed("saved.restart");
		checkpoint("saved.bound");
		assert.equal(
			getPendingHotspotCreation(target.owner),
			undefined,
			"Confirmation did not retire creation authority",
		);
		process.stdout.write(
			"first-ap: saved-profile backend Stop/Start confirmed; credential UUID remains bound\n",
		);
		await nativeRecoveryCase(target, row, probe, checkpoint);
	} finally {
		if (openDeadline !== undefined) clearTimeout(openDeadline);
		if (confirmationDeadline !== undefined) clearTimeout(confirmationDeadline);
		client?.close();
		await server?.stop(true);
		terminateWifiDiscovery();
		wifiRadioObservation.stop();
		removeWifiInterface(target.owner);
		const currentIds = getWifiIdToMacAddress();
		if (id !== undefined && currentIds[id] === target.owner)
			delete currentIds[id];
	}
}
