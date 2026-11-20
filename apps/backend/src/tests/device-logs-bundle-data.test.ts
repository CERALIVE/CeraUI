import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { MOCK_DEVICE_STATS } from "../mocks/providers/device-stats.ts";
import * as config from "../modules/config.ts";
import { collectBundleData } from "../modules/device-logs/bundle-data.ts";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import * as stored from "../modules/events/store.ts";
import * as credentials from "../modules/modems/modem-credentials.ts";
import * as modemState from "../modules/modems/modems-state.ts";
import {
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";
import * as routers from "../modules/network/router-cellular-scan.ts";
import * as relays from "../modules/remote/remote-relays.ts";
import * as stats from "../modules/system/device-stats-snapshot.ts";
import * as hardware from "../modules/system/hardware-kind.ts";
import * as updates from "../modules/system/update-settings.ts";
import * as versions from "../modules/system/version-context.ts";
import * as hotspots from "../modules/wifi/hotspot-credentials.ts";
import { bootId, queryFixture } from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
const current = {
	bootId,
	osImage: null,
	slot: null,
	board: null,
	boardModel: null,
	ceraui: "ui",
	engine: null,
	senderVersion: null,
	kernel: null,
	bun: null,
};
const restores: Array<() => void> = [];
function restore(spy: { mockRestore(): void }) {
	restores.push(() => spy.mockRestore());
}
beforeEach(() => {
	fixture = queryFixture();
	restore(spyOn(versions, "collectVersionContext").mockResolvedValue(current));
	restore(
		spyOn(updates, "readUpdateChannel").mockResolvedValue(
			updateSettingsSchema.parse({ channel: "stable" }).channel,
		),
	);
	restore(
		spyOn(config, "getConfig").mockReturnValue({
			password: "ui-pass",
			password_hash: "DO-NOT-READ-HASH",
			ssh_pass: "ssh-pass",
			ssh_pass_hash: "DO-NOT-READ-SSH-HASH",
			remote_key: "remote-key",
			srt_streamid: "stream-id",
			relay_streamid_override: "override-key",
			pairing_secret: "pairing-key",
			autostart: false,
		}),
	);
	restore(
		spyOn(relays, "getRelays").mockReturnValue({
			bcrp_key: "bcrp-key",
			servers: {},
			accounts: { first: { name: "account", ingest_key: "ingest-key" } },
		}),
	);
	restore(
		spyOn(hotspots, "getAllHotspotCredentials").mockReturnValue([
			{ ssid: "private-network", password: "hotspot-pass" },
		]),
	);
	restore(
		spyOn(modemState, "getModems").mockReturnValue({
			1: {
				ifname: "wwan0",
				name: "modem",
				sim_network: "",
				network_type: { supported: {}, active: null },
				config: {
					conn: "uuid",
					autoconfig: false,
					apn: "apn",
					username: "apn-user",
					password: "apn-pass",
					roaming: false,
					network: "",
				},
			},
			2: {
				ifname: "wwan1",
				name: "no config",
				sim_network: "",
				network_type: { supported: {}, active: null },
			},
		}),
	);
	restore(
		spyOn(routers, "getRouterCellularMarkers").mockReturnValue(
			new Map([
				[
					"eth1",
					{
						vendor: "vendor",
						model: "model",
						vid_pid: "12d1:14dc",
						kind: "router-cellular",
						duplicate_model: true,
						serial: "serial-private",
					},
				],
				[
					"eth2",
					{
						vendor: "vendor",
						model: "model",
						vid_pid: "12d1:14dc",
						kind: "router-cellular",
						duplicate_model: false,
					},
				],
			]),
		),
	);
	restore(spyOn(stored, "readEvents").mockReturnValue([]));
	restore(spyOn(stored, "readBoots").mockReturnValue([]));
	restore(spyOn(hardware, "getHardwareKindCached").mockReturnValue("rk3588"));
	restore(
		spyOn(stats, "getDeviceStatsSnapshot").mockReturnValue({
			...MOCK_DEVICE_STATS,
			disk: { used: 123, total: 456, type: "eMMC" },
		}),
	);
	credentials.resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	credentials.writeModemCredential(
		resolvePhysicalDevice({
			ifname: "old0",
			serial: "offline-serial",
			vid: "12d1",
			pid: "14dc",
		}),
		{ username: "router-user", password: "router-pass", lastVerifiedAt: 42 },
	);
});
afterEach(() => {
	for (const reset of restores.splice(0)) reset();
	fixture.restore();
	credentials.resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
});

test.each([false, true])(
	"collection selects current and previous boots in either input order (%s)",
	async (reverse) => {
		const base = (await fixture.list())[0];
		if (!base) throw new Error("missing base");
		const prev = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const rows = [
			{
				...base,
				current: true,
				index: 0,
				versions: { ...current, osImage: "boot-os" },
			},
			{
				...base,
				bootId: prev,
				index: -1,
				versions: { ...current, bootId: prev, osImage: "old-os" },
			},
			{
				...base,
				bootId: "cccccccccccccccccccccccccccccccc",
				index: -2,
				logsAvailable: false,
			},
			{ ...base, bootId: "dddddddddddddddddddddddddddddddd", index: -8 },
		];
		fixture.list.mockResolvedValue(reverse ? [...rows].reverse() : rows);
		const result = await collectBundleData();
		expect(result.journalBoots).toEqual([bootId, prev]);
		expect(result.boots).toEqual([
			{ bootId, versions: { ...current, osImage: "boot-os" } },
			{
				bootId: prev,
				versions: { ...current, bootId: prev, osImage: "old-os" },
			},
		]);
		expect(result.settings).toEqual({
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable",
			autostart: false,
			hardwareKind: "rk3588",
			data: { used: 123, total: 456 },
		});
		const facts = JSON.stringify({ ...result, secrets: undefined });
		for (const secret of [
			"ui-pass",
			"ssh-pass",
			"DO-NOT-READ",
			"private-network",
			"apn-user",
			"router-pass",
		])
			expect(facts).not.toContain(secret);
	},
);

test("every held credential class including disconnected router logins is collected solely for redaction", async () => {
	const result = await collectBundleData();
	expect(() => buildRedactor(result.secrets)).not.toThrow();
	expect(result.secrets.map((secret) => secret.value).sort()).toEqual(
		[
			"ui-pass",
			"ssh-pass",
			"remote-key",
			"stream-id",
			"override-key",
			"pairing-key",
			"bcrp-key",
			"ingest-key",
			"hotspot-pass",
			"apn-user",
			"apn-pass",
			"router-user",
			"router-pass",
			"serial-private",
		].sort(),
	);
});

test("missing data stays unknown and a missing current journal boot never borrows an old context", async () => {
	spyOn(stats, "getDeviceStatsSnapshot").mockReturnValue(undefined);
	spyOn(config, "getConfig").mockReturnValue({});
	spyOn(relays, "getRelays").mockReturnValue(undefined);
	fixture.list.mockResolvedValue([]);
	const result = await collectBundleData();
	expect(result.journalBoots).toEqual([bootId]);
	expect(result.boots).toEqual([{ bootId, versions: null }]);
	expect(result.settings.data).toBeNull();
	expect(result.settings.autostart).toBeNull();
	expect(result.secrets.some((secret) => secret.value === "undefined")).toBe(
		false,
	);
});

test("the credential snapshot returns copies without private identity or verification metadata", () => {
	const snapshot = credentials.getStoredModemCredentials();
	expect(snapshot).toEqual([
		{ username: "router-user", password: "router-pass" },
	]);
	const first = snapshot[0];
	if (!first) throw new Error("missing credential");
	Object.assign(first, { username: "changed" });
	expect(credentials.getStoredModemCredentials()).toEqual([
		{ username: "router-user", password: "router-pass" },
	]);
});
