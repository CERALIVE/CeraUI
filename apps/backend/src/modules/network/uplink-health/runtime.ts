import { logger } from "../../../helpers/logger.ts";
import { buildLinkTelemetry } from "../../streaming/link-telemetry.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import {
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
	type ProbeCandidate,
} from "../connectivity-candidates.ts";
import { probeConnectivityViaDevice } from "../device-bound-probe.ts";
import {
	getNetworkInterfaces,
	type NetworkInterface,
	onNetworkInterfacesChange,
} from "../network-interfaces.ts";
import { resolveUplinkIdentity } from "../uplink-identity.ts";
import {
	type ConnectivityTargetResolver,
	createConnectivityTargetResolver,
} from "./connectivity-target.ts";
import {
	UPLINK_HEALTH_CONFIG,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
	type UplinkObservation,
} from "./model.ts";
import { getUplinkHealthEngine, notifyUplinkHealthChange } from "./state.ts";

export const UPLINKS_EVENT = "uplinks" as const;

export interface UplinkHealthRuntimeDeps {
	readonly now: () => number;
	readonly interfaces: () => Record<string, NetworkInterface>;
	readonly onInterfacesChange?: (callback: () => void) => () => void;
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
	onInterfacesChange: onNetworkInterfacesChange,
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

export class UplinkHealthRuntime {
	readonly #engine = getUplinkHealthEngine();
	readonly #deps: UplinkHealthRuntimeDeps;
	#lastJson = "";
	#round = 0;
	#completedRound = 0;
	#generation = 0;
	#unsubscribe: (() => void) | undefined;
	readonly #samples = new Map<
		string,
		{
			readonly present: boolean;
			readonly ip: string | undefined;
			readonly eligible: boolean;
			readonly generation: number;
			round: number;
		}
	>();

	constructor(deps: UplinkHealthRuntimeDeps = defaultDeps) {
		this.#deps = deps;
	}

	async tick(): Promise<void> {
		// Subscribe on first use: the netif import graph cycles back here before
		// its event emitter is initialized.
		this.#unsubscribe ??= this.#deps.onInterfacesChange?.(() =>
			this.#sampleInterfaces(this.#deps.interfaces()),
		);
		const round = ++this.#round;
		const now = this.#deps.now();
		const interfaces = this.#deps.interfaces();
		const present = new Set(Object.keys(interfaces));
		this.#engine.removeMissing(present);
		this.#sampleInterfaces(interfaces);
		const passive = this.#passiveIfaces(now, round);
		const candidates = eligibleProbeCandidates(interfaces);

		for (const iface of present) {
			const entry = interfaces[iface];
			if (!entry?.ip) {
				this.#observe(
					{
						iface,
						...resolveUplinkIdentity(iface),
						outcome: "definitive_loss",
						now,
					},
					round,
				);
			}
		}

		const active = candidates.filter(
			(candidate) => !passive.has(candidate.name),
		);
		const generations = new Map(
			active.map((candidate) => [
				candidate.name,
				this.#samples.get(candidate.name)?.generation,
			]),
		);
		// Candidate addresses are primitive snapshots, independent of the mutable
		// netif entries. A newer observation or completed tick owns later evidence;
		// merely starting another slow round must not starve current probes.
		const isCurrent = (candidate: ProbeCandidate): boolean => {
			const entry = this.#deps.interfaces()[candidate.name];
			return (
				round >= this.#completedRound &&
				round >= (this.#samples.get(candidate.name)?.round ?? 0) &&
				generations.get(candidate.name) ===
					this.#samples.get(candidate.name)?.generation &&
				entry?.ip === candidate.ip &&
				deviceBoundProbeExclusionReason(entry) === undefined
			);
		};
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
				const batch = active
					.slice(offset, offset + UPLINK_HEALTH_CONFIG.maxConcurrentProbes)
					.filter(isCurrent);
				const outcomes = await Promise.all(
					batch.map((candidate) => this.#deps.probe(candidate.name, target)),
				);
				for (const [index, candidate] of batch.entries()) {
					if (!isCurrent(candidate)) continue;
					this.#observe(
						{
							iface: candidate.name,
							...resolveUplinkIdentity(candidate.name),
							outcome: outcomes[index] ?? "failure",
							now,
						},
						round,
					);
				}
			}
		}
		this.#completedRound = Math.max(this.#completedRound, round);
		const current = this.#deps.interfaces();
		for (const [iface, sample] of this.#samples) {
			if (!current[iface] && sample.round <= this.#completedRound) {
				this.#samples.delete(iface);
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

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	#sampleInterfaces(interfaces: Record<string, NetworkInterface>): void {
		for (const iface of new Set([
			...Object.keys(interfaces),
			...this.#samples.keys(),
		])) {
			const entry = interfaces[iface];
			const present = entry !== undefined;
			const ip = entry?.ip;
			const eligible = deviceBoundProbeExclusionReason(entry) === undefined;
			const previous = this.#samples.get(iface);
			if (
				!previous ||
				previous.present !== present ||
				previous.ip !== ip ||
				previous.eligible !== eligible
			) {
				// Events record even A -> B -> A changes entirely between ticks.
				// Never reuse a generation after removed samples are retired.
				this.#samples.set(iface, {
					present,
					ip,
					eligible,
					generation: ++this.#generation,
					round: this.#round,
				});
			}
		}
	}

	#observe(observation: UplinkObservation, round: number): void {
		const sample = this.#samples.get(observation.iface);
		if (sample) sample.round = round;
		this.#engine.observe(observation);
	}

	#passiveIfaces(now: number, round: number): ReadonlySet<string> {
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
			this.#observe(
				{
					iface: link.iface,
					...resolveUplinkIdentity(link.iface),
					outcome: expired
						? "definitive_loss"
						: degraded
							? "passive_degraded"
							: "success",
					now,
				},
				round,
			);
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
	runtime.dispose();
	runtime = next ?? new UplinkHealthRuntime();
}
