/**
 * Bluetooth Procedures — the operator surface over `modules/bluetooth/`.
 *
 * This layer TRANSLATES and GATES; it never re-implements. The per-adapter S5
 * lock, the S7 pending stamps, the bounded discovery window and every typed
 * BlueZ degradation are applied INSIDE the stack, so a handler here that took
 * its own lock would be a second, drifting guard over one radio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "THE OPERATOR SWITCHED IT OFF" IS NOT "BlueZ IS BROKEN"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The stack records BOTH as `bt_unavailable`, because from its own point of view
 * they are the same fact — it is not observing BlueZ. They are opposite facts to
 * an operator: one is a switch they can flip, the other is a service fault. So
 * every mutating handler checks the persisted preference FIRST and answers
 * `bluetooth_disabled`, and only past that gate does a `bt_unavailable` mean
 * what its cause says.
 */

import {
	type BluetoothMutationOutput,
	type BluetoothMutationRefusal,
	type BluetoothToggleOutput,
	bluetoothDeviceInputSchema,
	bluetoothMutationOutputSchema,
	bluetoothScanStartInputSchema,
	bluetoothScanStopInputSchema,
	bluetoothStatusSchema,
	bluetoothToggleInputSchema,
	bluetoothToggleOutputSchema,
	bluetoothTrustInputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import {
	broadcastBluetoothIfChanged,
	getBluetoothStack,
	getBluetoothStatusMessage,
	refreshBluetoothStack,
} from "../../modules/bluetooth/bluetooth-runtime.ts";
import {
	type BluetoothResult,
	type BtUnavailableCause,
	isBtUnavailable,
	setBluetoothEnabled,
} from "../../modules/bluetooth/index.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const authedProcedure = os.$context<RPCContext>().use(authMiddleware);

/**
 * `unit_missing` folds into `service_start_failed` because both mean the same
 * thing to the operator: the switch did not take. Every other cause keeps its
 * own member — a dead `bluetoothd`, an unreachable bus and a board with no
 * controller send someone to three different places.
 */
function refusalFromUnavailable(
	cause: BtUnavailableCause,
): BluetoothMutationRefusal {
	switch (cause) {
		case "emulated":
			return "bt_unavailable_in_emulated_mode";
		case "bluez_unavailable":
			return "bluez_unavailable";
		case "bus_unreachable":
			return "bus_unreachable";
		case "no_adapter":
			return "no_adapter";
		case "unit_missing":
			return "service_start_failed";
	}
}

/**
 * Project one stack result onto the shared wire answer.
 *
 * `bluezErrorRefusal` lets ONE caller re-label a BlueZ rejection: a failed
 * `Device1.Pair` is a `pairing_failed`, not a generic `bluez_error`, and the
 * BlueZ error name still rides along for the log.
 */
function toMutationOutput<T>(
	result: BluetoothResult<T>,
	bluezErrorRefusal: BluetoothMutationRefusal = "bluez_error",
): BluetoothMutationOutput {
	if (result.ok) return { success: true };

	if (isBtUnavailable(result)) {
		return {
			success: false,
			error: refusalFromUnavailable(result.cause),
			...(result.detail !== undefined ? { detail: result.detail } : {}),
		};
	}

	if (result.error === "bluez_error") {
		return {
			success: false,
			error: bluezErrorRefusal,
			...(result.bluezError !== undefined
				? { bluezError: result.bluezError }
				: {}),
			...(result.detail !== undefined ? { detail: result.detail } : {}),
		};
	}

	return {
		success: false,
		error: result.error,
		...(result.heldBy !== undefined ? { heldBy: result.heldBy } : {}),
		...(result.detail !== undefined ? { detail: result.detail } : {}),
	};
}

/** `undefined` when Bluetooth is on; the refusal to answer with when it is not. */
function disabledRefusal(): BluetoothMutationOutput | undefined {
	return getBluetoothStack().state().enabled
		? undefined
		: { success: false, error: "bluetooth_disabled" };
}

/**
 * Run a stack mutation behind the preference gate, then publish.
 *
 * The broadcast is unconditional on completion because a mutation that REFUSED
 * can still have moved the wire — the S7 pending stamp is set and cleared around
 * every attempt — and `broadcastBluetoothIfChanged` sends nothing when the
 * payload did not actually move.
 */
async function runMutation<T>(
	run: () => Promise<BluetoothResult<T>>,
	bluezErrorRefusal?: BluetoothMutationRefusal,
): Promise<BluetoothMutationOutput> {
	const blocked = disabledRefusal();
	if (blocked !== undefined) return blocked;

	const result = await run();
	broadcastBluetoothIfChanged();
	return toMutationOutput(result, bluezErrorRefusal);
}

/** Persist the operator's answer, reconcile the units, re-observe, publish. */
async function applyEnabled(enabled: boolean): Promise<BluetoothToggleOutput> {
	const outcome = await setBluetoothEnabled(enabled);

	if (isBtUnavailable(outcome)) {
		return {
			success: false,
			error: refusalFromUnavailable(outcome.cause),
			...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
		};
	}

	const refused = outcome.units.filter((unit) => !unit.applied);
	if (refused.length > 0) {
		return {
			success: false,
			error: "service_start_failed",
			detail: refused
				.map((unit) => `${unit.unit}: ${unit.detail ?? "refused"}`)
				.join("; "),
		};
	}

	await refreshBluetoothStack();
	return { success: true, applied: { enabled: outcome.enabled } };
}

export const getBluetoothStatusProcedure = authedProcedure
	.output(bluetoothStatusSchema)
	.handler(() => bluetoothStatusSchema.parse(getBluetoothStatusMessage()));

export const bluetoothEnableProcedure = authedProcedure
	.input(bluetoothToggleInputSchema)
	.output(bluetoothToggleOutputSchema)
	.handler(() => applyEnabled(true));

export const bluetoothDisableProcedure = authedProcedure
	.input(bluetoothToggleInputSchema)
	.output(bluetoothToggleOutputSchema)
	.handler(() => applyEnabled(false));

export const bluetoothScanStartProcedure = authedProcedure
	.input(bluetoothScanStartInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() =>
			getBluetoothStack().startDiscovery(input.adapterPath, {
				...(input.transport !== undefined
					? { transport: input.transport }
					: {}),
				...(input.rssi !== undefined ? { rssi: input.rssi } : {}),
				...(input.uuids !== undefined ? { uuids: input.uuids } : {}),
			}),
		),
	);

export const bluetoothScanStopProcedure = authedProcedure
	.input(bluetoothScanStopInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() => getBluetoothStack().stopDiscovery(input.adapterPath)),
	);

/**
 * Pair one device.
 *
 * A BlueZ rejection is re-labelled `pairing_failed`, EXCEPT when this build has
 * no `org.bluez.Agent1` registered because it ships no D-Bus object server — in
 * which case the honest answer is `pairing_agent_unavailable`, because CeraUI
 * cannot answer the callbacks BlueZ makes during a pairing. The pairing is still
 * ATTEMPTED rather than pre-refused: a host that registers its own agent, or a
 * peer that needs no authorization, can legitimately complete one, and refusing
 * up front would withdraw a control that sometimes works. `getStatus().agent`
 * carries the same fact before the operator ever taps, so the gap is stated in
 * both places rather than discovered from a pairing that quietly never lands.
 */
export const bluetoothPairProcedure = authedProcedure
	.input(bluetoothDeviceInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) => {
		const agent = getBluetoothStack().state().agent;
		const refusal: BluetoothMutationRefusal =
			!agent.registered && agent.reason === "exporter_unavailable"
				? "pairing_agent_unavailable"
				: "pairing_failed";
		return runMutation(
			() => getBluetoothStack().pair(input.devicePath),
			refusal,
		);
	});

export const bluetoothTrustProcedure = authedProcedure
	.input(bluetoothTrustInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() =>
			getBluetoothStack().setTrusted(input.devicePath, input.trusted),
		),
	);

export const bluetoothForgetProcedure = authedProcedure
	.input(bluetoothDeviceInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() => getBluetoothStack().forget(input.devicePath)),
	);

export const bluetoothConnectProcedure = authedProcedure
	.input(bluetoothDeviceInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() => getBluetoothStack().connectDevice(input.devicePath)),
	);

export const bluetoothDisconnectProcedure = authedProcedure
	.input(bluetoothDeviceInputSchema)
	.output(bluetoothMutationOutputSchema)
	.handler(({ input }) =>
		runMutation(() => getBluetoothStack().disconnectDevice(input.devicePath)),
	);
