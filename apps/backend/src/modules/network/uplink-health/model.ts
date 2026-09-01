export const UPLINK_HEALTH_CONFIG = {
	failedRoundsDown: 3,
	successfulRoundsUp: 5,
	holdDownMs: 15_000,
	probeRoundCadenceMs: 5_000,
	maxConcurrentProbes: 3,
	telemetryExpiryMs: 15_000,
	degradedWeight: 25,
	passiveRttDegradedMs: 1_000,
	passiveNakDegradedCount: 25,
} as const;

export type UplinkKind = "ethernet" | "wifi" | "cellular" | "other";
export type UplinkHealthState = "up" | "degraded" | "down";
export type UplinkHealthReason =
	| "probe_failed"
	| "captive_portal"
	| "passive_congestion"
	| "definitive_loss";
export type UplinkHealthOutcome =
	| "success"
	| "failure"
	| "captive_portal"
	| "passive_degraded"
	| "definitive_loss";

export interface UplinkHealthRecord {
	readonly iface: string;
	readonly kind: UplinkKind;
	/** Absent whenever the device could not be named. Never invented. */
	readonly displayName?: string;
	readonly state: UplinkHealthState;
	readonly reason?: UplinkHealthReason;
	readonly weight: number;
	readonly lastTransition: number;
	readonly staleAt: number;
	readonly probes: {
		readonly successes: number;
		readonly failures: number;
	};
	readonly signals: {
		readonly activeAt?: number;
		readonly passiveAt?: number;
	};
}

export interface UplinkObservation {
	readonly iface: string;
	readonly kind: UplinkKind;
	readonly displayName?: string;
	readonly outcome: UplinkHealthOutcome;
	readonly now: number;
}

const weightFor = (state: UplinkHealthState): number => {
	switch (state) {
		case "up":
			return 100;
		case "degraded":
			return UPLINK_HEALTH_CONFIG.degradedWeight;
		case "down":
			return 0;
	}
};

const reasonFor = (
	outcome: UplinkHealthOutcome,
): UplinkHealthReason | undefined => {
	switch (outcome) {
		case "success":
			return undefined;
		case "failure":
			return "probe_failed";
		case "captive_portal":
			return "captive_portal";
		case "passive_degraded":
			return "passive_congestion";
		case "definitive_loss":
			return "definitive_loss";
	}
};

export class UplinkHealthEngine {
	readonly #records = new Map<string, UplinkHealthRecord>();

	observe(observation: UplinkObservation): UplinkHealthRecord {
		const previous = this.#records.get(observation.iface);
		const current = previous ?? this.#initialRecord(observation);
		const next = this.#reduce(current, observation);
		this.#records.set(observation.iface, next);
		return next;
	}

	get(iface: string): UplinkHealthRecord | undefined {
		return this.#records.get(iface);
	}

	list(): readonly UplinkHealthRecord[] {
		return [...this.#records.values()].sort((a, b) =>
			a.iface.localeCompare(b.iface),
		);
	}

	removeMissing(ifaces: ReadonlySet<string>): void {
		for (const iface of this.#records.keys()) {
			if (!ifaces.has(iface)) this.#records.delete(iface);
		}
	}

	isClientSteeringEligible(iface: string): boolean {
		return this.#records.get(iface)?.state !== "down";
	}

	#initialRecord(observation: UplinkObservation): UplinkHealthRecord {
		const { iface, kind, displayName, now } = observation;
		return {
			iface,
			kind,
			...(displayName === undefined ? {} : { displayName }),
			state: "up",
			weight: 100,
			lastTransition: now,
			staleAt: now + UPLINK_HEALTH_CONFIG.telemetryExpiryMs,
			probes: { successes: 0, failures: 0 },
			signals: {},
		};
	}

	#reduce(
		current: UplinkHealthRecord,
		observation: UplinkObservation,
	): UplinkHealthRecord {
		const passive =
			observation.outcome === "passive_degraded" ||
			observation.outcome === "definitive_loss";
		const probes = this.#nextCounters(current, observation.outcome);
		const state = this.#nextState(current, observation, probes);
		const transitioned = state !== current.state;
		const reason = state === "up" ? undefined : reasonFor(observation.outcome);
		return {
			iface: observation.iface,
			kind: observation.kind,
			// Absence RETRACTS: a device whose marker sweep stopped naming it must
			// stop claiming a name, or a resolved identity latches onto whatever
			// re-enumerates under that interface next.
			...(observation.displayName === undefined
				? {}
				: { displayName: observation.displayName }),
			state,
			...(reason === undefined ? {} : { reason }),
			weight: weightFor(state),
			lastTransition: transitioned ? observation.now : current.lastTransition,
			staleAt: observation.now + UPLINK_HEALTH_CONFIG.telemetryExpiryMs,
			probes,
			signals: passive
				? { ...current.signals, passiveAt: observation.now }
				: { ...current.signals, activeAt: observation.now },
		};
	}

	#nextCounters(
		current: UplinkHealthRecord,
		outcome: UplinkHealthOutcome,
	): UplinkHealthRecord["probes"] {
		switch (outcome) {
			case "success":
				return { successes: current.probes.successes + 1, failures: 0 };
			case "failure":
				return { successes: 0, failures: current.probes.failures + 1 };
			case "captive_portal":
			case "passive_degraded":
			case "definitive_loss":
				return { successes: 0, failures: 0 };
		}
	}

	#nextState(
		current: UplinkHealthRecord,
		observation: UplinkObservation,
		probes: UplinkHealthRecord["probes"],
	): UplinkHealthState {
		switch (observation.outcome) {
			case "captive_portal":
			case "passive_degraded":
				return "degraded";
			case "definitive_loss":
				return "down";
			case "failure":
				return probes.failures >= UPLINK_HEALTH_CONFIG.failedRoundsDown
					? "down"
					: current.state;
			case "success": {
				if (current.state === "up") return "up";
				const dwellMet =
					observation.now - current.lastTransition >=
					UPLINK_HEALTH_CONFIG.holdDownMs;
				return dwellMet &&
					probes.successes >= UPLINK_HEALTH_CONFIG.successfulRoundsUp
					? "up"
					: current.state;
			}
		}
	}
}
