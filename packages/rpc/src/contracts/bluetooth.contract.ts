/**
 * Bluetooth ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	bluetoothDeviceInputSchema,
	bluetoothMutationOutputSchema,
	bluetoothScanStartInputSchema,
	bluetoothScanStopInputSchema,
	bluetoothStatusSchema,
	bluetoothToggleInputSchema,
	bluetoothToggleOutputSchema,
	bluetoothTrustInputSchema,
} from '../schemas';

export const bluetoothContract = oc.router({
	/**
	 * The whole Bluetooth surface in one read: adapter rows, the device
	 * registry, the service/observation state, the pairing-agent state, and the
	 * five-state capability claims.
	 */
	getStatus: oc.output(bluetoothStatusSchema),

	/**
	 * Persist "Bluetooth on" and reconcile the systemd units to it.
	 * `systemctl enable --now` — persistent, so it survives a reboot.
	 */
	enable: oc.input(bluetoothToggleInputSchema).output(bluetoothToggleOutputSchema),

	/**
	 * Persist "Bluetooth off" and reconcile the units to it.
	 * `systemctl disable --now` — persistent-SYMMETRIC with `enable`; a stop-only
	 * disable would silently reverse itself on the next boot.
	 */
	disable: oc.input(bluetoothToggleInputSchema).output(bluetoothToggleOutputSchema),

	/** Start a BOUNDED discovery window on one adapter. */
	scanStart: oc.input(bluetoothScanStartInputSchema).output(bluetoothMutationOutputSchema),

	/** Stop discovery on one adapter before its window elapses. */
	scanStop: oc.input(bluetoothScanStopInputSchema).output(bluetoothMutationOutputSchema),

	/** Pair one device. The request IS the pairing window — see the agent state. */
	pair: oc.input(bluetoothDeviceInputSchema).output(bluetoothMutationOutputSchema),

	/** Set (or revoke) the trust flag that governs boot reconnect. */
	trust: oc.input(bluetoothTrustInputSchema).output(bluetoothMutationOutputSchema),

	/** Remove a device from the adapter entirely. */
	forget: oc.input(bluetoothDeviceInputSchema).output(bluetoothMutationOutputSchema),

	/** Connect an already-paired device. */
	connect: oc.input(bluetoothDeviceInputSchema).output(bluetoothMutationOutputSchema),

	/** Disconnect a connected device without forgetting it. */
	disconnect: oc.input(bluetoothDeviceInputSchema).output(bluetoothMutationOutputSchema),
});
