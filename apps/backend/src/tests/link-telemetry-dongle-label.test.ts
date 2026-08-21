/**
 * Per-link telemetry names a claimed dongle by its SLOT, not by its veth.
 *
 * `dg0h` is a kernel name an operator cannot act on; `dongle0` is the label the
 * netns manager itself assigns. This drives the REAL default resolver (the lazy
 * import, not the `setIfaceResolverForTest` double) so the substitution is
 * proven at the seam production actually uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import {
	type DongleMetadata,
	type DongleMetadataDeps,
	refreshDongleMetadata,
	resetDongleMetadata,
} from "../modules/network/dongle-metadata.ts";
import {
	getNetworkInterfaces,
	processIfconfigOutput,
	resetDongleMarkerTracking,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	buildLinkTelemetry,
	loadDefaultIfaceResolverWithRetry,
	setIfaceResolverForTest,
	setResolverLoaderForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";

const NOW = 1_755_331_200_000;

function record(over: Partial<DongleMetadata> = {}): DongleMetadata {
	return {
		version: 1,
		slot: 0,
		ifname: "eth1",
		usb_path: "platform-fc800000.usb-usb-0:1.3.2",
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: "192.168.8.100",
		inner_gateway: "192.168.8.1",
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "up",
		updated_at_ms: NOW,
		lease_refresh_ms: 30000,
		...over,
	};
}

function metadataDeps(records: DongleMetadata[]): DongleMetadataDeps {
	const files: Record<string, string> = {};
	for (const r of records) {
		files[`/run/ceralive/dongles/dongle${r.slot}.json`] = JSON.stringify(r);
	}
	return {
		listFiles: async () => Object.keys(files),
		readFile: async (path) => files[path],
		now: () => NOW,
	};
}

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.0.255`,
		"        ether aa:bb:cc:dd:ee:ff  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function snapshot(ipCount: number): Telemetry {
	return {
		last_updated_ms: NOW,
		connections: Array.from({ length: ipCount }, (_, i) => ({
			conn_id: String(i),
			rtt_ms: 0,
			nak_count: 0,
			weight_percent: 100,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
		})),
	} as Telemetry;
}

function captureWatch() {
	const calls: Array<(u: TelemetryUpdate) => void> = [];
	const watch: typeof WatchTelemetryFn = (_path, cb) => {
		calls.push(cb);
		return { stop: () => undefined };
	};
	return {
		watch,
		emit: (t: Telemetry) => {
			for (const cb of calls) cb({ data: t, stale: false });
		},
	};
}

beforeEach(async () => {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	resetDongleMetadata();
	resetDongleMarkerTracking();
	setQueueUpdateGwHook(null);
	setIfaceResolverForTest(null);
	// Restore the REAL lazy-import loader and drop any cached resolver, so each
	// case re-resolves against the netif/dongle state it just set up.
	setResolverLoaderForTest(null);
});

afterEach(() => {
	stopLinkTelemetry();
	setIfaceResolverForTest(null);
	setResolverLoaderForTest(null);
	resetDongleMetadata();
});

describe("link telemetry iface resolution — dongle slot label", () => {
	test("a claimed dongle's link is labelled dongle<N>, not dg<N>h", async () => {
		await refreshDongleMetadata(
			metadataDeps([
				record({ slot: 3, veth_host: "dg3h", veth_host_ip: "10.208.3.1" }),
			]),
		);
		processIfconfigOutput(ifconfigStanza("dg3h", "10.208.3.1"));

		const w = captureWatch();
		startLinkTelemetry("/tmp/does-not-exist.json", ["10.208.3.1"], {
			watch: w.watch,
		});
		await loadDefaultIfaceResolverWithRetry();
		w.emit(snapshot(1));

		expect(buildLinkTelemetry()?.links[0]?.iface).toBe("dongle3");
	});

	test("an ordinary interface keeps its first-IP-match name", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(ifconfigStanza("eth0", "192.168.78.132"));

		const w = captureWatch();
		startLinkTelemetry("/tmp/does-not-exist.json", ["192.168.78.132"], {
			watch: w.watch,
		});
		await loadDefaultIfaceResolverWithRetry();
		w.emit(snapshot(1));

		expect(buildLinkTelemetry()?.links[0]?.iface).toBe("eth0");
	});

	test("a veth with no live claim keeps its kernel name", async () => {
		processIfconfigOutput(ifconfigStanza("dg0h", "10.208.0.1"));

		const w = captureWatch();
		startLinkTelemetry("/tmp/does-not-exist.json", ["10.208.0.1"], {
			watch: w.watch,
		});
		await loadDefaultIfaceResolverWithRetry();
		w.emit(snapshot(1));

		expect(buildLinkTelemetry()?.links[0]?.iface).toBe("dg0h");
	});
});
