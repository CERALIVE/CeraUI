/**
 * Export-surface SNAPSHOT / regression lock for `protocol.ts`.
 *
 * `protocol.ts` was rewritten from a hand-written per-repo Zod derivation into a
 * THIN re-export of the shared `@ceralive/control-protocol` package (with local
 * alias wrappers so the device keeps its TOLERANT variant of every colliding
 * name). This test freezes the module's public RUNTIME surface — every value the
 * device-side code and tests import — so that migration (and any future package
 * bump) can never silently DROP a symbol or change its runtime KIND.
 *
 * It is deliberately a SUPERSET-tolerant check: every baseline symbol MUST still
 * be present with its recorded kind, but the module MAY grow additional exports
 * (the rewrite adds the `tolerantParse*` helpers). Types are erased at runtime, so
 * only value exports appear here — that is exactly the surface a `typeof` /
 * `Object.keys()` map captures.
 */

import { describe, expect, it } from "bun:test";

import * as protocol from "./protocol.ts";

type SurfaceKind =
	| "array"
	| "zodschema"
	| "string"
	| "number"
	| "boolean"
	| "function";

function kindOf(value: unknown): SurfaceKind | "unknown" {
	if (Array.isArray(value)) return "array";
	if (typeof value === "function") return "function";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (
		typeof value === "object" &&
		value !== null &&
		"safeParse" in value &&
		typeof (value as { safeParse: unknown }).safeParse === "function"
	) {
		return "zodschema";
	}
	return "unknown";
}

/**
 * The frozen baseline: every runtime symbol the pre-package `protocol.ts` exported,
 * mapped to its runtime kind. Captured 2026-07-07 from the hand-written module
 * immediately before the `@ceralive/control-protocol` migration (25 symbols).
 */
const BASELINE_SURFACE: Readonly<Record<string, SurfaceKind>> = {
	// ── plain constants ──────────────────────────────────────────────────────
	PROTOCOL_VERSION: "number",
	ACTIVE_PROFILE_STATUS: "string",
	SELF_FENCING_WATCHDOG_MS: "number",
	// ── closed registries / enum arrays ──────────────────────────────────────
	FRAME_KINDS: "array",
	ROLES: "array",
	INTERNAL_COMMANDS: "array",
	COMMAND_REGISTRY: "array",
	SELF_FENCING_TYPES: "array",
	NEVER_REMOTE: "array",
	STATUS_TYPES: "array",
	// ── Zod schemas (device-tolerant variants for the colliding names) ────────
	EnvelopeSchema: "zodschema",
	CommandSchema: "zodschema",
	IngestSlotSchema: "zodschema",
	IngestSlotsPayloadSchema: "zodschema",
	ResultPayloadSchema: "zodschema",
	ResultSchema: "zodschema",
	StatusSchema: "zodschema",
	AckSchema: "zodschema",
	DeliveryAckSchema: "zodschema",
	HandshakeSchema: "zodschema",
	DeviceCapsSchema: "zodschema",
	HandshakeDeviceSchema: "zodschema",
	HandshakeHubSchema: "zodschema",
	FrameSchema: "zodschema",
	// ── functions ─────────────────────────────────────────────────────────────
	isInternalCommand: "function",
} as const;

describe("protocol.ts export-surface snapshot (regression lock)", () => {
	const surface = protocol as unknown as Record<string, unknown>;

	it("exposes every baseline symbol with its recorded runtime kind", () => {
		for (const [name, expectedKind] of Object.entries(BASELINE_SURFACE)) {
			expect(name in surface, `missing export: ${name}`).toBe(true);
			expect(kindOf(surface[name]), `kind mismatch for ${name}`).toBe(
				expectedKind,
			);
		}
	});

	it("captures a complete typeof map of every runtime export", () => {
		// A pure `Object.keys()` / `typeof` snapshot — proves the module still
		// resolves (no broken re-export) and records the full current surface.
		const map = Object.fromEntries(
			Object.keys(surface)
				.sort()
				.map((k) => [k, kindOf(surface[k])]),
		);
		// Every baseline key must appear in the live map with a known kind.
		for (const name of Object.keys(BASELINE_SURFACE)) {
			expect(map[name]).not.toBe("unknown");
		}
		// The surface never SHRINKS below the baseline (25 device symbols).
		expect(Object.keys(surface).length).toBeGreaterThanOrEqual(
			Object.keys(BASELINE_SURFACE).length,
		);
	});

	it("locks the wire literal values of the closed registries", () => {
		// These are the byte-precise device wire contract — a package bump that
		// reordered or dropped a registry entry would break routing silently.
		expect(protocol.PROTOCOL_VERSION).toBe(1);
		expect(protocol.ACTIVE_PROFILE_STATUS).toBe("device.activeProfile");
		expect(protocol.SELF_FENCING_WATCHDOG_MS).toBe(30_000);
		expect([...protocol.FRAME_KINDS]).toEqual([
			"command",
			"status",
			"result",
			"ack",
			"handshake",
			"delivery.ack",
		]);
		expect([...protocol.ROLES]).toEqual(["owner", "copilot", "viewer"]);
		expect([...protocol.INTERNAL_COMMANDS]).toEqual([
			"ingest.slots",
			"device.setProfile",
		]);
		expect([...protocol.COMMAND_REGISTRY]).toEqual([
			"streaming.start",
			"streaming.stop",
			"streaming.setBitrate",
			"streaming.setConfig",
			"streaming.getConfig",
			"streaming.getPipelines",
			"network.reconfig",
			"modem.reconfig",
			"device.remoteKeyChange",
			"system.reboot",
			"device.factoryReset",
			"self_fencing.confirm",
			"ingest.slots",
			"device.setProfile",
		]);
		expect([...protocol.SELF_FENCING_TYPES]).toEqual([
			"network.reconfig",
			"modem.reconfig",
			"device.remoteKeyChange",
			"system.reboot",
			"device.factoryReset",
		]);
		expect([...protocol.NEVER_REMOTE]).toEqual([
			"auth.login",
			"auth.setPassword",
		]);
		expect([...protocol.STATUS_TYPES]).toEqual([
			"status",
			"config",
			"sensors",
			"netif",
			"modems",
			"device-stats",
			"notifications",
			"telemetry",
			"device.activeProfile",
		]);
	});

	it("preserves isInternalCommand behaviour", () => {
		expect(protocol.isInternalCommand("ingest.slots")).toBe(true);
		expect(protocol.isInternalCommand("device.setProfile")).toBe(true);
		expect(protocol.isInternalCommand("streaming.start")).toBe(false);
	});
});
