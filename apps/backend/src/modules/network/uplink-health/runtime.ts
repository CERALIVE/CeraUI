import { logger } from "../../../helpers/logger.ts";
import { buildLinkTelemetry } from "../../streaming/link-telemetry.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { eligibleProbeCandidates } from "../connectivity-candidates.ts";
import { probeConnectivityViaDevice } from "../device-bound-probe.ts";
import {
	getNetworkInterfaces,
	type NetworkInterface,
} from "../network-interfaces.ts";
import {
	UPLINK_HEALTH_CONFIG,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
	type UplinkKind,
} from "./model.ts";
import { getUplinkHealthEngine, notifyUplinkHealthChange } from "./state.ts";

export const UPLINKS_EVENT = "uplinks" as const;

export type ProbeTargetClass = "gateway" | "public_ip" | "https_204";
const PROBE_TARGETS: readonly ProbeTargetClass[] = [
	"gateway",
	"public_ip",
	"https_204",
];

export interface UplinkHealthRuntimeDeps {
	readonly now: () => number;
	readonly interfaces: () => Record<string, NetworkInterface>;
	readonly streaming: () => boolean;
	readonly telemetry: typeof buildLinkTelemetry;
	readonly probe: (
		iface: string,
		target: ProbeTargetClass,
	) => Promise<UplinkHealthOutcome>;
	readonly publish: (records: readonly UplinkHealthRecord[]) => void;
}

const defaultDeps: UplinkHealthRuntimeDeps = {
	now: Date.now,
	interfaces: getNetworkInterfaces,
	streaming: getIsStreaming,
	telemetry: buildLinkTelemetry,
	probe: async (iface) => {
		const result = await probeConnectivityViaDevice("1.1.1.1", iface);
		switch (result) {
			case "reachable":
				return "success";
			case "captive_portal":
				return "captive_portal";
			case "unreachable":
				return "failure";
		}
	},
	publish: (records) => broadcastMsg(UPLINKS_EVENT, records),
};

const kindFor = (iface: string): UplinkKind => {
	if (iface.startsWith("wl")) return "wifi";
	if (/^(?:ww|ppp|usb|enx)/.test(iface)) return "cellular";
	if (/^(?:eth|en)/.test(iface)) return "ethernet";
	return "other";
};

export class UplinkHealthRuntime {
	readonly #engine = getUplinkHealthEngine();
	readonly #deps: UplinkHealthRuntimeDeps;
	#round = 0;
	#lastJson = "";

	constructor(deps: UplinkHealthRuntimeDeps = defaultDeps) {
		this.#deps = deps;
	}

	async tick(): Promise<void> {
		const now = this.#deps.now();
		const interfaces = this.#deps.interfaces();
		const present = new Set(Object.keys(interfaces));
		this.#engine.removeMissing(present);
		const passive = this.#passiveIfaces(now);
		const candidates = eligibleProbeCandidates(interfaces);

		for (const iface of present) {
			const entry = interfaces[iface];
			if (!entry?.ip) {
				this.#engine.observe({
					iface,
					kind: kindFor(iface),
					outcome: "definitive_loss",
					now,
				});
			}
		}

		const target =
			PROBE_TARGETS[this.#round % PROBE_TARGETS.length] ?? "https_204";
		this.#round++;
		const active = candidates.filter(
			(candidate) => !passive.has(candidate.name),
		);
		for (
			let offset = 0;
			offset < active.length;
			offset += UPLINK_HEALTH_CONFIG.maxConcurrentProbes
		) {
			const batch = active.slice(
				offset,
				offset + UPLINK_HEALTH_CONFIG.maxConcurrentProbes,
			);
			const outcomes = await Promise.all(
				batch.map((candidate) => this.#deps.probe(candidate.name, target)),
			);
			for (const [index, candidate] of batch.entries()) {
				this.#engine.observe({
					iface: candidate.name,
					kind: kindFor(candidate.name),
					outcome: outcomes[index] ?? "failure",
					now,
				});
			}
		}
		this.#publishIfChanged();
	}

	records(): readonly UplinkHealthRecord[] {
		return this.#engine.list();
	}

	isClientSteeringEligible(iface: string): boolean {
		return this.#engine.isClientSteeringEligible(iface);
	}

	#passiveIfaces(now: number): ReadonlySet<string> {
		const passive = new Set<string>();
		if (!this.#deps.streaming()) return passive;
		const telemetry = this.#deps.telemetry();
		if (!telemetry) return passive;
		for (const link of telemetry.links) {
			passive.add(link.iface);
			const expired =
				now - telemetry.lastReadMs >= UPLINK_HEALTH_CONFIG.telemetryExpiryMs;
			const degraded =
				link.stale ||
				link.rtt_ms >= UPLINK_HEALTH_CONFIG.passiveRttDegradedMs ||
				link.nak_count >= UPLINK_HEALTH_CONFIG.passiveNakDegradedCount;
			this.#engine.observe({
				iface: link.iface,
				kind: kindFor(link.iface),
				outcome: expired
					? "definitive_loss"
					: degraded
						? "passive_degraded"
						: "success",
				now,
			});
		}
		return passive;
	}

	#publishIfChanged(): void {
		const records = this.#engine.list();
		const json = JSON.stringify(records);
		if (json === this.#lastJson) return;
		this.#lastJson = json;
		notifyUplinkHealthChange(records);
		this.#deps.publish(records);
	}
}

let runtime = new UplinkHealthRuntime();
let interval: ReturnType<typeof setInterval> | undefined;

export function initUplinkHealth(): void {
	if (interval !== undefined) return;
	void runtime.tick().catch((error: unknown) => {
		logger.warn("uplink-health tick failed", { err: error });
	});
	interval = setInterval(() => {
		void runtime.tick().catch((error: unknown) => {
			logger.warn("uplink-health tick failed", { err: error });
		});
	}, UPLINK_HEALTH_CONFIG.probeRoundCadenceMs);
}

export function setUplinkHealthRuntimeForTest(
	next: UplinkHealthRuntime | null,
): void {
	runtime = next ?? new UplinkHealthRuntime();
}
