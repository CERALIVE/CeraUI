import type {
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import type { PipelineAvailability } from "./pipelineAvailability";

import {
	deriveGoLiveReadiness,
	GATE_FIX_ORDER,
	type GoLiveGateKey,
	type GoLiveReadinessInput,
	READINESS_DESTINATION_REASON,
	READINESS_ENGINE_SCHEMA_REASON,
	READINESS_ENGINE_STARTING_REASON,
	READINESS_ENGINE_UNAVAILABLE_REASON,
	READINESS_NETWORK_REASON,
	READINESS_SOURCE_REASON,
} from "./go-live-readiness";

// The gateway-inactive reason the sources builder (T2) and pipelineAvailability
// both emit — the exact string the QA failure scenario asserts.
const GATEWAY_INACTIVE_REASON = "live.education.reason.gatewayInactive";

const GATEWAY_OK: PipelineAvailability = { available: true };
const GATEWAY_INACTIVE: PipelineAvailability = {
	available: false,
	reason: GATEWAY_INACTIVE_REASON,
};

// ── Fixture builders ────────────────────────────────────────────────────────
// The module reads only a handful of optional config fields; casting a partial
// is the established pattern in this suite (see receiver-experience.test.ts).
function cfg(overrides: Partial<ConfigMessage> = {}): ConfigMessage {
	return overrides as ConfigMessage;
}

function caps(overrides: Partial<CapabilitiesMessage> = {}): CapabilitiesMessage {
	return overrides as CapabilitiesMessage;
}

/** A minimal virtual StreamSource — available by default; togglable per test. */
function source(
	id: string,
	extra: {
		available?: boolean;
		lost?: boolean;
		unavailableReason?: string;
	} = {},
): StreamSource {
	return {
		id,
		pipelineId: id,
		origin: "virtual",
		labelKey: "settings.sources.test",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: extra.available ?? true,
		...(extra.lost !== undefined ? { lost: extra.lost } : {}),
		...(extra.unavailableReason !== undefined
			? { unavailableReason: extra.unavailableReason }
			: {}),
	};
}

function sources(entries: StreamSource[]): SourcesMessage {
	return { hardware: "generic", sources: entries };
}

const NETIF_UP: NetifMessage = {
	eth0: { tp: 0, enabled: true, ip: "10.0.0.2" },
};

/** A fully-green input: every gate resolves `ok`, nothing blocks. */
function greenInput(): GoLiveReadinessInput {
	return {
		config: cfg({ source: "cam0", relay_server: "srv-1" }),
		caps: undefined,
		sources: sources([source("cam0")]),
		netif: NETIF_UP,
		isConnected: true,
		gatewayStatus: GATEWAY_OK,
	};
}

describe("deriveGoLiveReadiness — all-green (happy path)", () => {
	it("clears every gate and does not block", () => {
		const readiness = deriveGoLiveReadiness(greenInput());

		expect(readiness.gates.source.state).toBe("ok");
		expect(readiness.gates.network.state).toBe("ok");
		expect(readiness.gates.destination.state).toBe("ok");
		expect(readiness.gates.engine.state).toBe("ok");
		expect(readiness.blocking).toBe(false);
		expect(readiness.primaryFixGate).toBeUndefined();
	});

	it("omits reason and fix on an ok gate", () => {
		const { gates } = deriveGoLiveReadiness(greenInput());
		expect(gates.source.reasonKey).toBeUndefined();
		expect(gates.source.fix).toBeUndefined();
	});
});

// ── Source gate ─────────────────────────────────────────────────────────────
describe("source gate", () => {
	it("ok — config.source resolves to an available entry", () => {
		const { gates } = deriveGoLiveReadiness(greenInput());
		expect(gates.source.state).toBe("ok");
	});

	it("blocked — no source selected", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ relay_server: "srv-1" }),
		});
		expect(gates.source).toEqual({
			state: "blocked",
			reasonKey: READINESS_SOURCE_REASON,
			fix: "openSource",
		});
	});

	it("blocked — selected id is absent from the offered set (stale/legacy)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "ghost", relay_server: "srv-1" }),
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe(READINESS_SOURCE_REASON);
		expect(gates.source.fix).toBe("openSource");
	});

	it("blocked — a lost device surfaces its own reason", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0", relay_server: "srv-1" }),
			sources: sources([
				source("cam0", { lost: true, unavailableReason: "some.lost.key" }),
			]),
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe("some.lost.key");
	});

	it("blocked — a lost device with no reason falls back to the source reason", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			sources: sources([source("cam0", { lost: true })]),
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe(READINESS_SOURCE_REASON);
	});

	it("blocked — gateway-inactive network source surfaces the gateway reason (QA)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "rtmp", relay_server: "srv-1" }),
			sources: sources([
				source("rtmp", {
					available: false,
					unavailableReason: GATEWAY_INACTIVE_REASON,
				}),
			]),
			gatewayStatus: GATEWAY_INACTIVE,
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe(GATEWAY_INACTIVE_REASON);
		expect(gates.source.fix).toBe("openSource");
	});

	it("blocked — a non-gateway unavailable device surfaces its own reason", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			sources: sources([
				source("cam0", {
					available: false,
					unavailableReason: "device.busy",
				}),
			]),
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe("device.busy");
	});

	it("blocked — an unavailable device with no reason falls back", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			sources: sources([source("cam0", { available: false })]),
		});
		expect(gates.source.state).toBe("blocked");
		expect(gates.source.reasonKey).toBe(READINESS_SOURCE_REASON);
	});
});

// ── Network gate ────────────────────────────────────────────────────────────
describe("network gate", () => {
	it("ok — at least one enabled interface with an IP", () => {
		const { gates } = deriveGoLiveReadiness(greenInput());
		expect(gates.network.state).toBe("ok");
	});

	it("blocked — no interfaces at all", () => {
		const { gates } = deriveGoLiveReadiness({ ...greenInput(), netif: {} });
		expect(gates.network).toEqual({
			state: "blocked",
			reasonKey: READINESS_NETWORK_REASON,
			fix: "goNetwork",
		});
	});

	it("blocked — netif snapshot absent", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			netif: undefined,
		});
		expect(gates.network.state).toBe("blocked");
	});

	it("blocked — an enabled interface with no IP does not count", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			netif: { eth0: { tp: 0, enabled: true } },
		});
		expect(gates.network.state).toBe("blocked");
	});

	it("blocked — an interface with an IP but disabled does not count", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			netif: { eth0: { tp: 0, enabled: false, ip: "10.0.0.2" } },
		});
		expect(gates.network.state).toBe("blocked");
	});

	it("blocked — control channel down (netif snapshot untrusted)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			isConnected: false,
		});
		expect(gates.network.state).toBe("blocked");
	});
});

// ── Destination gate ────────────────────────────────────────────────────────
describe("destination gate", () => {
	it("ok — a selected relay server", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0", relay_server: "srv-1" }),
		});
		expect(gates.destination.state).toBe("ok");
	});

	it("ok — a selected managed ingest endpoint", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0", selected_ingest_endpoint: "slot-7" }),
		});
		expect(gates.destination.state).toBe("ok");
	});

	it("ok — a manual SRTLA address", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0", srtla_addr: "203.0.113.9" }),
		});
		expect(gates.destination.state).toBe("ok");
	});

	it("blocked — no server target of any kind", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0" }),
		});
		expect(gates.destination).toEqual({
			state: "blocked",
			reasonKey: READINESS_DESTINATION_REASON,
			fix: "openServer",
		});
	});
});

// ── Engine gate ─────────────────────────────────────────────────────────────
describe("engine gate", () => {
	it("ok — normal tier (no caps flags)", () => {
		const { gates } = deriveGoLiveReadiness(greenInput());
		expect(gates.engine.state).toBe("ok");
	});

	it("ok — a caps snapshot with every tier flag false", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({
				engineUnavailable: false,
				engineStarting: false,
				schemaVersionMismatch: false,
			}),
		});
		expect(gates.engine.state).toBe("ok");
	});

	it("blocked — engine unavailable", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({ engineUnavailable: true }),
		});
		expect(gates.engine).toEqual({
			state: "blocked",
			reasonKey: READINESS_ENGINE_UNAVAILABLE_REASON,
			fix: "none",
		});
	});

	it("warn — engine starting (advisory, never blocks)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({ engineStarting: true }),
		});
		expect(gates.engine).toEqual({
			state: "warn",
			reasonKey: READINESS_ENGINE_STARTING_REASON,
			fix: "none",
		});
	});

	it("warn — schema-version mismatch (advisory, never blocks)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({ schemaVersionMismatch: true }),
		});
		expect(gates.engine).toEqual({
			state: "warn",
			reasonKey: READINESS_ENGINE_SCHEMA_REASON,
			fix: "none",
		});
	});

	it("blocked — control channel down (engine unreachable)", () => {
		const { gates } = deriveGoLiveReadiness({
			...greenInput(),
			isConnected: false,
		});
		expect(gates.engine.state).toBe("blocked");
		expect(gates.engine.reasonKey).toBe(READINESS_ENGINE_UNAVAILABLE_REASON);
	});
});

// ── blocking + primaryFixGate ───────────────────────────────────────────────
describe("primaryFixGate", () => {
	it("names the first blocked gate in fix order (source wins over destination)", () => {
		const readiness = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({}), // no source AND no server → source + destination blocked
		});
		expect(readiness.gates.source.state).toBe("blocked");
		expect(readiness.gates.destination.state).toBe("blocked");
		expect(readiness.primaryFixGate).toBe("source");
	});

	it("points at destination when it is the only block", () => {
		const readiness = deriveGoLiveReadiness({
			...greenInput(),
			config: cfg({ source: "cam0" }),
		});
		expect(readiness.primaryFixGate).toBe("destination");
	});

	it("points at engine when it is the only block", () => {
		const readiness = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({ engineUnavailable: true }),
		});
		expect(readiness.primaryFixGate).toBe("engine");
	});

	it("a warn-only gate never blocks", () => {
		const readiness = deriveGoLiveReadiness({
			...greenInput(),
			caps: caps({ engineStarting: true }),
		});
		expect(readiness.blocking).toBe(false);
		expect(readiness.primaryFixGate).toBeUndefined();
	});

	it("prefers network over destination when both block (disconnect)", () => {
		// A down channel blocks BOTH network and engine; network precedes engine.
		const readiness = deriveGoLiveReadiness({
			...greenInput(),
			isConnected: false,
			config: cfg({ source: "cam0" }), // also destination-blocked
		});
		expect(readiness.gates.network.state).toBe("blocked");
		expect(readiness.gates.destination.state).toBe("blocked");
		expect(readiness.gates.engine.state).toBe("blocked");
		expect(readiness.primaryFixGate).toBe("network");
	});
});

// ── Table-driven proof: blocking === (any gate blocked) ──────────────────────
describe("blocking === (any gate blocked) — full truth table", () => {
	// Each gate is driven INDEPENDENTLY (isConnected stays true so it never
	// toggles two gates at once): source ← config.source, network ← netif,
	// destination ← relay_server, engine ← caps.engineUnavailable.
	function tableInput(flags: {
		sourceOk: boolean;
		networkOk: boolean;
		destinationOk: boolean;
		engineOk: boolean;
	}): GoLiveReadinessInput {
		return {
			config: cfg({
				...(flags.sourceOk ? { source: "cam0" } : {}),
				...(flags.destinationOk ? { relay_server: "srv-1" } : {}),
			}),
			caps: flags.engineOk ? undefined : caps({ engineUnavailable: true }),
			sources: sources([source("cam0")]),
			netif: flags.networkOk ? NETIF_UP : {},
			isConnected: true,
			gatewayStatus: GATEWAY_OK,
		};
	}

	const bools = [false, true] as const;

	for (const sourceOk of bools) {
		for (const networkOk of bools) {
			for (const destinationOk of bools) {
				for (const engineOk of bools) {
					const label = `source=${sourceOk} network=${networkOk} destination=${destinationOk} engine=${engineOk}`;
					it(`holds for ${label}`, () => {
						const readiness = deriveGoLiveReadiness(
							tableInput({ sourceOk, networkOk, destinationOk, engineOk }),
						);

						// Each gate blocks exactly when its flag is false.
						expect(readiness.gates.source.state === "blocked").toBe(!sourceOk);
						expect(readiness.gates.network.state === "blocked").toBe(
							!networkOk,
						);
						expect(readiness.gates.destination.state === "blocked").toBe(
							!destinationOk,
						);
						expect(readiness.gates.engine.state === "blocked").toBe(!engineOk);

						// The invariant under proof.
						const anyBlocked = (
							Object.values(readiness.gates) as { state: string }[]
						).some((gate) => gate.state === "blocked");
						expect(readiness.blocking).toBe(anyBlocked);

						// primaryFixGate is the first blocked gate in fix order, or absent.
						const expectedPrimary: GoLiveGateKey | undefined = GATE_FIX_ORDER.find(
							(key) => readiness.gates[key].state === "blocked",
						);
						expect(readiness.primaryFixGate).toBe(expectedPrimary);
					});
				}
			}
		}
	}
});
