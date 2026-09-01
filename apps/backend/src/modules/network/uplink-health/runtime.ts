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
	type ConnectivityTargetResolver,
	createConnectivityTargetResolver,
} from "./connectivity-target.ts";
import {
	UPLINK_HEALTH_CONFIG,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
	type UplinkKind,
} from "./model.ts";
import { getUplinkHealthEngine, notifyUplinkHealthChange } from "./state.ts";

export const UPLINKS_EVENT = "uplinks" as const;

export interface UplinkHealthRuntimeDeps {
	readonly now: () => number;
	readonly interfaces: () => Record<string, NetworkInterface>;
	readonly streaming: () => boolean;
	readonly telemetry: typeof buildLinkTelemetry;
	/**
	 * The address the round's probes are aimed at, or `undefined` when it could
	 * not be established. `undefined` SKIPS the active probe round — see `tick`.
	 */
	readonly resolveTarget: ConnectivityTargetResolver;
	/**
	 * One device-bound probe. `remoteAddr` is the RESOLVED connectivity-check
	 * address, never a hardcoded literal and never a gateway: the probe asserts
	 * `internet.ts`'s 204-with-empty-body contract, so it has to be aimed at
	 * something that actually serves it.
	 */
	readonly probe: (
		iface: string,
		remoteAddr: string,
	) => Promise<UplinkHealthOutcome>;
	readonly publish: (records: readonly UplinkHealthRecord[]) => void;
}

/*
  Built on FIRST USE, never at module scope. `connectivity-target.ts` reaches
  `dns.ts`/`internet.ts`, and that graph comes back here through
  `gateways.ts -> uplink-health/index.ts`, so constructing the resolver while
  this module is still initializing reads a `const` the cycle has not defined
  yet. One shared instance, so the TTL cache is shared by every default runtime.
*/
let sharedTarget: ConnectivityTargetResolver | undefined;
const resolveTargetShared: ConnectivityTargetResolver = () => {
	sharedTarget ??= createConnectivityTargetResolver();
	return sharedTarget();
};

const defaultDeps: UplinkHealthRuntimeDeps = {
	now: Date.now,
	interfaces: getNetworkInterfaces,
	streaming: getIsStreaming,
	telemetry: buildLinkTelemetry,
	resolveTarget: resolveTargetShared,
	probe: async (iface, remoteAddr) => {
		const result = await probeConnectivityViaDevice(remoteAddr, iface);
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

		const active = candidates.filter(
			(candidate) => !passive.has(candidate.name),
		);
		// An unresolvable check address is a statement about DNS, not about any
		// uplink, so the ACTIVE round is skipped whole rather than recording a
		// failure nothing measured. The passive telemetry and address-loss
		// observations above are independent evidence and still stand.
		const target =
			active.length > 0 ? await this.#deps.resolveTarget() : undefined;
		if (target !== undefined) {
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
