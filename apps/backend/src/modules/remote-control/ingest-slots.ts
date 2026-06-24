/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Remote Control Plane v2.0 — platform-pushed ingest slots → managed accounts (T18).
 *
 * The platform pushes the account's resolved ingest endpoints to the device via the
 * `ingest.slots` INTERNAL command (spec §5). Each slot becomes a MANAGED relay
 * account the on-device UI can select, keyed by its stable `endpointId`. This module
 * owns the device-side store: it validates the inbound payload (the device's own
 * lenient `IngestSlotsPayloadSchema`), maps each slot to a {@link ManagedIngestAccount},
 * and persists the operator's SELECTED slot by `endpointId` — never by host+port, so
 * the selection survives a re-push that moves the endpoint to a new host/port and
 * survives a reconnect (it lives in `config.json`).
 *
 * It does NOT replace the manual/custom endpoint path: managed accounts are additive.
 * Persistence is injected ({@link IngestSlotsDeps}) so selection is unit-testable
 * without touching `config.json`.
 */

import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { type IngestSlot, IngestSlotsPayloadSchema } from "./protocol.ts";

/**
 * A platform ingest slot mapped into the device's relay/receiver model. `key` is
 * the slot's `streamId` (its ingest credential); `label` falls back to `endpointId`
 * when the platform sends no `instanceLabel`. Identity is `endpointId`.
 */
export interface ManagedIngestAccount {
	endpointId: string;
	host: string;
	port: number;
	protocol: string;
	key: string;
	label: string;
	region?: string;
	state?: string;
	default?: boolean;
	/** Cloud OBS instance the platform bound this slot to, or `null` when unbound (T17). */
	obsInstanceId: string | null;
	/** Human label of the bound cloud OBS instance, when the platform pushed one (T17). */
	instanceLabel?: string;
}

/** Injected config persistence so selection round-trips without disk in tests. */
export interface IngestSlotsDeps {
	readSelected: () => string | undefined;
	writeSelected: (endpointId: string | undefined) => void;
}

export type IngestSlotsListener = (
	accounts: readonly ManagedIngestAccount[],
) => void;

function defaultDeps(): IngestSlotsDeps {
	return {
		readSelected: () => getConfig().selected_ingest_endpoint,
		writeSelected: (endpointId) => {
			const config = getConfig();
			if (endpointId === undefined) {
				delete config.selected_ingest_endpoint;
			} else {
				config.selected_ingest_endpoint = endpointId;
			}
			saveConfig();
		},
	};
}

interface IngestSlotsState {
	accounts: ManagedIngestAccount[];
	deps: IngestSlotsDeps;
}

let state: IngestSlotsState = { accounts: [], deps: defaultDeps() };
const listeners = new Set<IngestSlotsListener>();

function mapSlotToAccount(slot: IngestSlot): ManagedIngestAccount {
	return {
		endpointId: slot.endpointId,
		host: slot.host,
		port: slot.port,
		protocol: slot.protocol,
		key: slot.streamId,
		label: slot.instanceLabel ?? slot.endpointId,
		obsInstanceId: slot.obsInstanceId,
		...(slot.instanceLabel !== undefined
			? { instanceLabel: slot.instanceLabel }
			: {}),
		...(slot.region !== undefined ? { region: slot.region } : {}),
		...(slot.state !== undefined ? { state: slot.state } : {}),
		...(slot.default !== undefined ? { default: slot.default } : {}),
	};
}

function notifyListeners(): void {
	for (const listener of listeners) {
		try {
			listener(state.accounts);
		} catch (err) {
			logger.warn(
				`ingest-slots: listener threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}

/**
 * Apply an inbound `ingest.slots` payload: validate, map each slot to a managed
 * account (last write wins per `endpointId`), replace the store, and notify
 * listeners. Returns the new account list, or `null` when the payload is malformed
 * — a malformed push is IGNORED (store unchanged), never a crash.
 */
export function handleIngestSlots(
	payload: unknown,
): readonly ManagedIngestAccount[] | null {
	const parsed = IngestSlotsPayloadSchema.safeParse(payload);
	if (!parsed.success) {
		logger.debug("ingest-slots: dropped malformed ingest.slots payload");
		return null;
	}

	const byEndpoint = new Map<string, ManagedIngestAccount>();
	for (const slot of parsed.data.slots) {
		byEndpoint.set(slot.endpointId, mapSlotToAccount(slot));
	}
	state.accounts = [...byEndpoint.values()];

	notifyListeners();
	return state.accounts;
}

/** The current managed ingest accounts (most recent `ingest.slots` push). */
export function getManagedIngestAccounts(): readonly ManagedIngestAccount[] {
	return state.accounts;
}

/** The persisted selected slot's `endpointId`, or `undefined` when none is selected. */
export function getSelectedIngestEndpoint(): string | undefined {
	return state.deps.readSelected();
}

/**
 * Persist `endpointId` as the selected slot (by identity, not host+port). Returns
 * `false` without persisting when `endpointId` is not among the current managed
 * accounts, so a stale/unknown selection is never written.
 */
export function selectIngestSlot(endpointId: string): boolean {
	const known = state.accounts.some(
		(account) => account.endpointId === endpointId,
	);
	if (!known) return false;
	state.deps.writeSelected(endpointId);
	return true;
}

/** Subscribe to managed-account changes; returns an unsubscribe handle. */
export function onIngestSlotsChanged(
	listener: IngestSlotsListener,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test seam: override the injected persistence deps. */
export function configureIngestSlots(
	overrides: Partial<IngestSlotsDeps>,
): void {
	state.deps = { ...state.deps, ...overrides };
}

/** Test seam: reset the store, deps, and listeners to a clean floor. */
export function resetIngestSlots(): void {
	state = { accounts: [], deps: defaultDeps() };
	listeners.clear();
}
