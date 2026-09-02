/**
 * Bluetooth Zod schemas — the wire half of the BlueZ foundation.
 *
 * The device half lives in `apps/backend/src/modules/bluetooth/`; this file is
 * the ONLY declaration of what crosses the socket, so the backend projection and
 * any operator surface agree by construction rather than by convention.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `bluetooth` IS NOT A `CAPABILITY_MODULE`, AND IT REUSES THE LADDER ANYWAY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `CAPABILITY_MODULES` (`capability-modules.schema.ts`) is a CLOSED, modem-only,
 * default-OFF-forever enum: every member is gated behind
 * `config.modem_capabilities`, which has no `RUNTIME_CONFIG_DEFAULTS` entry, so
 * registering `bluetooth` there would make the whole surface invisible by design
 * — an operator would have to enable a cellular feature gate to see a headset.
 * What IS reused is the FIVE-STATE support-claim vocabulary
 * (`supportClaimStateSchema`) and its resolver, because the question it answers
 * is the same one asked here: is this shipped, switched on, proven on THIS
 * hardware, and certified. One vocabulary, two registries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MUTATION-REFUSAL VOCABULARY IS SHARED, NOT PER-PROCEDURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bluetoothMutationRefusalSchema` is the `modemMutationRefusalSchema` lesson
 * applied here: every mutating Bluetooth procedure answers the SAME enum, so a
 * blocked device reads the same on every surface and a per-procedure generic
 * error can never make "another mutation holds the radio" indistinguishable from
 * "the pairing itself failed". Each member names a different thing the operator
 * can do about it — do not collapse any two, and do not give a new procedure a
 * private set.
 */
import { z } from 'zod';

import { supportClaimStateSchema } from './capability-modules.schema';

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * A D-Bus object path (`/org/bluez/hci0`, `/org/bluez/hci0/dev_AA_BB_…`).
 *
 * SHAPE ONLY, deliberately. Which paths exist is a runtime fact the device
 * answers with (`bluetoothStatusSchema.adapters` / `.devices`); a schema that
 * tried to encode the adapter/device distinction would reject a legitimate BlueZ
 * path the moment BlueZ names one differently. It mirrors the device-side
 * `isObjectPath` parser so the two cannot disagree about what is well formed.
 */
export const BLUEZ_OBJECT_PATH_RE = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;

export const bluezObjectPathSchema = z
	.string()
	.min(1)
	.regex(BLUEZ_OBJECT_PATH_RE, { message: 'Must be a D-Bus object path' });

// ─── Device model ────────────────────────────────────────────────────────────

/**
 * What CeraLive can DO with a device, not what it is called.
 *
 * Mirrors the device-side `BluetoothDeviceClass`: `unknown` is the honest floor
 * for a device whose services BlueZ has not resolved, never a guess.
 */
export const BLUETOOTH_DEVICE_CLASSES = ['audio-input', 'unknown'] as const;
export const bluetoothDeviceClassSchema = z.enum(BLUETOOTH_DEVICE_CLASSES);
export type BluetoothDeviceClass = z.infer<typeof bluetoothDeviceClassSchema>;

/**
 * The LINK transport, and `unknown` is the common answer rather than a gap.
 *
 * It is derived from POSITIVE evidence only — a device advertising a BR/EDR-only
 * SIG profile (A2DP / HFP / HSP) proves BR/EDR — because nothing on the row
 * proves LE: BlueZ's `AddressType` is not published by the registry, and an
 * absent UUID list is a statement about what BlueZ has resolved, not about the
 * radio. So `le` and `dual` exist for a future read that can prove them, and
 * today a device that proves nothing reads `unknown` instead of being guessed
 * into a bucket an operator would then act on.
 */
export const BLUETOOTH_TRANSPORTS = ['bredr', 'le', 'dual', 'unknown'] as const;
export const bluetoothTransportSchema = z.enum(BLUETOOTH_TRANSPORTS);
export type BluetoothTransport = z.infer<typeof bluetoothTransportSchema>;

/** The mutations that can be in flight against one adapter or device. */
export const BLUETOOTH_MUTATION_KINDS = [
	'pair',
	'trust',
	'untrust',
	'forget',
	'connect',
	'disconnect',
	'power',
	'discovery',
] as const;
export const bluetoothMutationKindSchema = z.enum(BLUETOOTH_MUTATION_KINDS);
export type BluetoothMutationKind = z.infer<typeof bluetoothMutationKindSchema>;

/** A journal-style in-flight marker: WHAT is running and since WHEN. */
export const bluetoothPendingSchema = z.object({
	op: bluetoothMutationKindSchema,
	startedAtMs: z.number().int().nonnegative(),
});
export type BluetoothPending = z.infer<typeof bluetoothPendingSchema>;

/**
 * One device row, mirroring the device-side registry row.
 *
 * **`paired` / `trusted` / `connected` / `blocked` are REQUIRED, and that is the
 * contract rather than a style choice.** They are RECOVERABLE facts — a device
 * pairs and unpairs, connects and drops — and a consumer that merges an omitted
 * optional field can raise such a flag and never lower it again (the
 * `policy_route_missing` latch, exactly). Publishing an explicit `false` is what
 * makes "this headset disconnected" expressible at all. `battery` and `rssi` are
 * the opposite case and are correctly optional: absent means the device does not
 * expose the interface / is not advertising, which a rendered `0` would lie about.
 */
export const bluetoothDeviceSchema = z.object({
	path: bluezObjectPathSchema,
	/** The adapter that owns it; absent only for a path with no adapter parent. */
	adapterPath: bluezObjectPathSchema.optional(),
	/** BlueZ `Address`. Absent until BlueZ has published one. */
	address: z.string().min(1).optional(),
	/** `Alias` when one is set, else `Name`. Absent for an unnamed advertisement. */
	name: z.string().min(1).optional(),
	deviceClass: bluetoothDeviceClassSchema,
	transport: bluetoothTransportSchema,
	paired: z.boolean(),
	trusted: z.boolean(),
	connected: z.boolean(),
	blocked: z.boolean(),
	/**
	 * TRUE only when the device advertises HFP or HSP — the board can open its
	 * MICROPHONE. Never "it has some audio UUID"; an A2DP-source-only device is
	 * an `audio-input` with NO SCO leg.
	 */
	scoCapable: z.boolean(),
	/** `Battery1.Percentage`. ABSENT when the device exposes no battery service. */
	battery: z.number().int().min(0).max(100).optional(),
	/** Advertisement RSSI, present only while BlueZ is publishing one. */
	rssi: z.number().int().optional(),
	pending: bluetoothPendingSchema.optional(),
});
export type BluetoothDevice = z.infer<typeof bluetoothDeviceSchema>;

/** One controller row. Same recoverable-boolean rule as the device row. */
export const bluetoothAdapterSchema = z.object({
	path: bluezObjectPathSchema,
	address: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
	powered: z.boolean(),
	discovering: z.boolean(),
	discoverable: z.boolean(),
	pairable: z.boolean(),
	pending: bluetoothPendingSchema.optional(),
});
export type BluetoothAdapter = z.infer<typeof bluetoothAdapterSchema>;

// ─── Availability + agent ────────────────────────────────────────────────────

/**
 * WHY Bluetooth is unavailable. Four different sentences, never collapsed: a dev
 * host with no radio, a `bluetoothd` that is not running, a board with no
 * controller, and a bus we could not reach call for different operator actions.
 */
export const BLUETOOTH_UNAVAILABLE_CAUSES = [
	'emulated',
	'bluez_unavailable',
	'bus_unreachable',
	'no_adapter',
	'unit_missing',
] as const;
export const bluetoothUnavailableCauseSchema = z.enum(BLUETOOTH_UNAVAILABLE_CAUSES);
export type BluetoothUnavailableCause = z.infer<typeof bluetoothUnavailableCauseSchema>;

/**
 * Why the `org.bluez.Agent1` pairing agent is not registered.
 *
 * `exporter_unavailable` is the one that is TRUE ON EVERY DEVICE TODAY, and it
 * is on the wire precisely so nobody has to discover it from a failed pairing:
 * the shared `DbusTransport` is a CLIENT (call + subscribe), with no object
 * export and no name ownership, so there is nothing for BlueZ to call back into.
 * The module deliberately registers NOTHING in that state rather than naming a
 * path no object answers — `RegisterAgent` pointing at a dead object makes BlueZ
 * block on every callback until it times out, which is a pairing that fails
 * slowly and blames the peer. Supplying a production exporter is a separate,
 * larger change; this field is how the device says so out loud in the meantime.
 */
export const BLUETOOTH_AGENT_FAILURES = [
	'exporter_unavailable',
	'export_failed',
	'bluez_refused',
] as const;
export const bluetoothAgentFailureSchema = z.enum(BLUETOOTH_AGENT_FAILURES);
export type BluetoothAgentFailure = z.infer<typeof bluetoothAgentFailureSchema>;

export const bluetoothAgentStateSchema = z.object({
	registered: z.boolean(),
	isDefaultAgent: z.boolean(),
	/** Present ONLY when `registered` is false. */
	reason: bluetoothAgentFailureSchema.optional(),
});
export type BluetoothAgentState = z.infer<typeof bluetoothAgentStateSchema>;

// ─── Capability claims — the FIVE-STATE ladder, reused ───────────────────────

/**
 * The Bluetooth features a claim is made about.
 *
 * A SEPARATE registry from `CAPABILITY_MODULES` (see the module header), keyed
 * on what an operator surface actually decides to render:
 *
 *   adapter    — is there a controller this build can drive at all
 *   pairing    — can this device COMPLETE a pairing it initiates (the agent)
 *   audio-input— can a paired device be opened as an audio source
 *   battery    — does the stack report a device battery level
 */
export const BLUETOOTH_CAPABILITY_FEATURES = [
	'adapter',
	'pairing',
	'audio-input',
	'battery',
] as const;
export const bluetoothCapabilityFeatureSchema = z.enum(BLUETOOTH_CAPABILITY_FEATURES);
export type BluetoothCapabilityFeature = z.infer<typeof bluetoothCapabilityFeatureSchema>;

/**
 * TOTAL, for the same reason `capabilityModuleClaimsSchema` is: a claim
 * published only when true can be raised and never lowered on any consumer that
 * merges, so every feature is stated on every answer. A `z.record` over the
 * feature enum makes the schema itself enforce it.
 */
export const bluetoothCapabilityClaimsSchema = z.record(
	bluetoothCapabilityFeatureSchema,
	supportClaimStateSchema,
);
export type BluetoothCapabilityClaims = z.infer<typeof bluetoothCapabilityClaimsSchema>;

// ─── getStatus output ────────────────────────────────────────────────────────

/**
 * The whole operator-visible Bluetooth surface in one read.
 *
 * `available` and `enabled` are DIFFERENT questions and both are explicit:
 * `enabled` is the operator's own persisted answer to "should this device do
 * Bluetooth", `available` is whether the stack is actually observing BlueZ right
 * now. A device whose operator has Bluetooth ON but whose `bluetoothd` is down is
 * `{enabled: true, available: false, unavailable: {cause: 'bluez_unavailable'}}`,
 * and rendering that as a plain "off" would hide a fault behind a setting.
 */
export const bluetoothStatusSchema = z.object({
	available: z.boolean(),
	enabled: z.boolean(),
	/** Present ONLY when `available` is false — the two are never both meaningful. */
	unavailable: z
		.object({
			cause: bluetoothUnavailableCauseSchema,
			/** Diagnostic for the log. NEVER rendered to an operator verbatim. */
			detail: z.string().optional(),
		})
		.optional(),
	adapters: z.array(bluetoothAdapterSchema),
	devices: z.array(bluetoothDeviceSchema),
	agent: bluetoothAgentStateSchema,
	/** The one bounded boot reconnect has been attempted this process lifetime. */
	bootReconnectDone: z.boolean(),
	capabilities: bluetoothCapabilityClaimsSchema,
});
export type BluetoothStatus = z.infer<typeof bluetoothStatusSchema>;

// ─── The shared mutation-refusal vocabulary ──────────────────────────────────

/**
 * Every mutating Bluetooth procedure answers THIS enum. See the module header
 * for why it is shared; the members, and what each tells the operator to do:
 *
 *   bt_unavailable_in_emulated_mode — a dev/emulated host: nothing to act on.
 *   bluetooth_disabled             — the operator has Bluetooth off; turn it on.
 *   bluez_unavailable              — `bluetoothd` is not answering; a service fault.
 *   bus_unreachable                — the SYSTEM BUS itself could not be reached,
 *                                    which is a different fault from a dead
 *                                    `bluetoothd` and calls for a different look.
 *   no_adapter                     — BlueZ is healthy and the board has no radio.
 *   unit_missing                   — a required systemd unit is not installed.
 *   service_start_failed           — `systemctl enable --now` was refused; the
 *                                    operator's switch did NOT take.
 *   adapter_busy                   — another mutation holds the radio; WAIT.
 *                                    Refused rather than queued, so a Forget can
 *                                    never land seconds after a Pair completed.
 *   pairing_failed                 — the pairing itself did not complete.
 *   pairing_agent_unavailable      — no `org.bluez.Agent1` is registered, so a
 *                                    CeraUI-initiated pairing cannot answer
 *                                    BlueZ's callbacks (see
 *                                    `bluetoothAgentFailureSchema`).
 *   unknown_device / unknown_adapter — the path names nothing this device knows.
 *   not_connected                  — the stack is not observing BlueZ.
 *   bluez_error                    — BlueZ named a D-Bus error; `bluezError`
 *                                    carries it verbatim for the log.
 */
export const BLUETOOTH_MUTATION_REFUSALS = [
	'bt_unavailable_in_emulated_mode',
	'bluetooth_disabled',
	'bluez_unavailable',
	'bus_unreachable',
	'no_adapter',
	'unit_missing',
	'service_start_failed',
	'adapter_busy',
	'pairing_failed',
	'pairing_agent_unavailable',
	'unknown_device',
	'unknown_adapter',
	'not_connected',
	'bluez_error',
] as const;
export const bluetoothMutationRefusalSchema = z.enum(BLUETOOTH_MUTATION_REFUSALS);
export type BluetoothMutationRefusal = z.infer<typeof bluetoothMutationRefusalSchema>;

/** The applied-state answer every mutating procedure returns. */
export const bluetoothMutationOutputSchema = z.object({
	success: z.boolean(),
	/** Present ONLY on failure. */
	error: bluetoothMutationRefusalSchema.optional(),
	/** The mutation holding the radio — present only with `adapter_busy`. */
	heldBy: bluetoothMutationKindSchema.optional(),
	/** The `org.bluez.Error.*` name, when BlueZ named one. */
	bluezError: z.string().optional(),
	/** Diagnostic for the log. NEVER rendered to an operator verbatim. */
	detail: z.string().optional(),
});
export type BluetoothMutationOutput = z.infer<typeof bluetoothMutationOutputSchema>;

// ─── Inputs — every mutation is `.strict()` ──────────────────────────────────
//
// An unknown extra key on a surface that powers a radio, opens a pairing window
// or removes a trusted device must be REJECTED rather than ignored: a client
// sending a field this device does not implement is a client acting on a
// contract that does not exist, and silently dropping it is how a UI comes to
// believe it set something.

/**
 * `enable` / `disable` take no arguments, and `.strict()` on the empty object is
 * exactly what makes that enforceable — the shape has nothing to widen into.
 */
export const bluetoothToggleInputSchema = z.object({}).strict();
export type BluetoothToggleInput = z.infer<typeof bluetoothToggleInputSchema>;

/** `enable` / `disable` additionally echo the persisted answer. */
export const bluetoothToggleOutputSchema = bluetoothMutationOutputSchema.extend({
	/** The preference actually persisted. Present only on success. */
	applied: z.object({ enabled: z.boolean() }).optional(),
});
export type BluetoothToggleOutput = z.infer<typeof bluetoothToggleOutputSchema>;

/**
 * `scanStart`. The adapter is REQUIRED: a board can carry two controllers, and
 * picking one for the operator would start a scan on a radio they can see is not
 * the one they chose. `getStatus().adapters[].path` is where it comes from.
 *
 * The filter mirrors BlueZ's `SetDiscoveryFilter` and every field is optional —
 * an omitted filter is `auto`, which is BlueZ's own default.
 */
export const bluetoothScanStartInputSchema = z
	.object({
		adapterPath: bluezObjectPathSchema,
		transport: z.enum(['auto', 'bredr', 'le']).optional(),
		/** Only report devices at or above this RSSI (dBm, negative). */
		rssi: z.number().int().optional(),
		uuids: z.array(z.string().min(1)).optional(),
	})
	.strict();
export type BluetoothScanStartInput = z.infer<typeof bluetoothScanStartInputSchema>;

export const bluetoothScanStopInputSchema = z
	.object({ adapterPath: bluezObjectPathSchema })
	.strict();
export type BluetoothScanStopInput = z.infer<typeof bluetoothScanStopInputSchema>;

/** `pair` / `forget` / `connect` / `disconnect` — one device, nothing else. */
export const bluetoothDeviceInputSchema = z.object({ devicePath: bluezObjectPathSchema }).strict();
export type BluetoothDeviceInput = z.infer<typeof bluetoothDeviceInputSchema>;

/**
 * `trust` is the trust-FLAG setter, so it carries the value.
 *
 * It defaults to `true` (the procedure is named for what an operator almost
 * always means) while still being able to REVOKE trust, which is what stops a
 * trusted device auto-reconnecting on every boot. A separate `untrust` procedure
 * would be a second name for one flag, and the two would drift.
 */
export const bluetoothTrustInputSchema = z
	.object({
		devicePath: bluezObjectPathSchema,
		trusted: z.boolean().default(true),
	})
	.strict();
export type BluetoothTrustInput = z.infer<typeof bluetoothTrustInputSchema>;
