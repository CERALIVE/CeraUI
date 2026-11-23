import { getConfig } from "../config.ts";
import { readBoots, readEvents } from "../events/store.ts";
import { getStoredModemCredentials } from "../modems/modem-credentials.ts";
import { getModems } from "../modems/modems-state.ts";
import { getRouterCellularMarkers } from "../network/router-cellular-scan.ts";
import { getRelays } from "../remote/remote-relays.ts";
import { getManagedIngestAccounts } from "../remote-control/ingest-slots.ts";
import { getDeviceStatsSnapshot } from "../system/device-stats-snapshot.ts";
import { getHardwareKindCached } from "../system/hardware-kind.ts";
import { readUpdateChannel } from "../system/update-settings.ts";
import { collectVersionContext } from "../system/version-context.ts";
import { getAllHotspotCredentials } from "../wifi/hotspot-credentials.ts";
import { listBoots } from "./boots.ts";
import { MIN_REDACTED_LENGTH } from "./redaction.ts";
import { getLogSettings, getLogState } from "./settings.ts";

interface BundleData {
	readonly exportedBy: LogBundleManifest["exportedBy"];
	readonly boots: ReadonlyArray<LogBundleManifest["boots"][number]>;
	readonly journalBoots: readonly string[];
	readonly settings: {
		readonly logs: ReturnType<typeof getLogSettings>;
		readonly state: ReturnType<typeof getLogState>;
		readonly updateChannel: Awaited<ReturnType<typeof readUpdateChannel>>;
		readonly autostart: boolean | null;
		readonly hardwareKind: ReturnType<typeof getHardwareKindCached>;
		readonly data: { readonly used: number; readonly total: number } | null;
	};
	readonly events: readonly DeviceEvent[];
	readonly bootRecords: readonly EventBootRecord[];
	readonly secrets: ReadonlyArray<{
		readonly kind: string;
		readonly value: string;
	}>;
}

/**
 * Held kinds whose values the log export still sends when they are too short
 * for the matcher (`MIN_REDACTED_LENGTH`). They name a stream, an APN account,
 * a router account or a device. Short stream IDs are treated as labels only
 * with no receiver configured or with a loopback receiver. A short value of any
 * other kind, including the APN and router passwords, the relay stream key
 * and any kind added later, still stops the export.
 */
export const SHORT_VALUE_EXPORT_KINDS: ReadonlySet<string> = new Set([
	"stream",
	"apn_user",
	"router_user",
	"serial",
]);

/**
 * Credentials the backend holds now, as redaction input only; the export and
 * bundle never write these values themselves.
 * A snapshot: values changed afterwards, and earlier values no longer held,
 * are not included.
 */
export function collectHeldSecrets(): Array<{ kind: string; value: string }> {
	const config = getConfig();
	const secrets: Array<{ kind: string; value: string }> = [];
	const add = (kind: string, value: string | undefined) => {
		if (value !== undefined) secrets.push({ kind, value });
	};
	add("password", config.password);
	add("ssh", config.ssh_pass);
	add("remote_key", config.remote_key);
	const externalReceiver =
		config.srtla_addr &&
		config.srtla_addr !== "127.0.0.1" &&
		config.srtla_addr !== "::1";
	const shortAmbiguousStream =
		(config.srt_streamid?.length ?? 0) < MIN_REDACTED_LENGTH &&
		(externalReceiver || config.relay_server || config.relay_account);
	add(
		config.selected_ingest_endpoint || shortAmbiguousStream
			? "ingest_key"
			: "stream",
		config.srt_streamid,
	);
	for (const account of getManagedIngestAccounts())
		add("ingest_key", account.key);
	// The relay override carries the selected account's ingest key.
	add("relay", config.relay_streamid_override);
	add("pairing", config.pairing_secret);
	const relays = getRelays();
	add("relay", relays?.bcrp_key);
	for (const account of Object.values(relays?.accounts ?? {}))
		add("relay", account.ingest_key);
	for (const hotspot of getAllHotspotCredentials())
		add("hotspot", hotspot.password);
	for (const modem of Object.values(getModems())) {
		add("apn_user", modem.config?.username);
		add("apn_password", modem.config?.password);
	}
	for (const credential of getStoredModemCredentials()) {
		add("router_user", credential.username);
		add("router_password", credential.password);
	}
	for (const marker of getRouterCellularMarkers().values())
		add("serial", marker.serial);
	return secrets;
}

export async function collectBundleData(): Promise<BundleData> {
	const config = getConfig();
	const secrets = collectHeldSecrets();
	const [exportedBy, available, updateChannel] = await Promise.all([
		collectVersionContext(),
		listBoots(),
		readUpdateChannel(),
	]);
	const previous = available
		.filter((boot) => boot.logsAvailable && boot.bootId !== exportedBy.bootId)
		.sort((a, b) => b.index - a.index)[0];
	const journalBoots = [
		exportedBy.bootId,
		...(previous ? [previous.bootId] : []),
	];
	const disk = getDeviceStatsSnapshot()?.disk;
	return structuredClone({
		exportedBy,
		boots: journalBoots.map((bootId) => ({
			bootId,
			versions:
				available.find((boot) => boot.bootId === bootId)?.versions ?? null,
		})),
		journalBoots,
		settings: {
			logs: getLogSettings(),
			state: getLogState(),
			updateChannel,
			autostart: config.autostart ?? null,
			hardwareKind: getHardwareKindCached(),
			data: disk ? { used: disk.used, total: disk.total } : null,
		},
		events: readEvents(),
		bootRecords: readBoots(),
		secrets,
	});
}

import type {
	DeviceEvent,
	EventBootRecord,
	LogBundleManifest,
} from "@ceraui/rpc/schemas";
