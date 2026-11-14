import {
	deriveModemStableKey,
	type ModemConfigInput,
	type ModemConfigOutput,
	type ModemConfigRefusal,
	normalizeModemConnectionFields,
} from "@ceraui/rpc/schemas";
import { setMockModemConfig } from "../../mocks/mock-service.ts";
import { shouldMockModems } from "../../mocks/providers/modems.ts";
import { broadcastModems } from "../../modules/modems/modem-status.ts";
import { getModemIdPath } from "../../modules/modems/modem-wire-producer.ts";
import {
	applyModemConfig,
	type ModemConfigOutcome,
} from "../../modules/modems/modems.ts";
import { getModem } from "../../modules/modems/modems-state.ts";
import { modemStableKeyForId } from "../../modules/modems/mutation-identity.ts";
import { withJournaledModemMutation } from "../../modules/modems/mutation-lease.ts";
import {
	getCachedUsagePolicy,
	type ModemUsagePolicy,
	usagePolicySlotKey,
	writeUsagePolicy,
} from "../../modules/modems/usage-policy.ts";
import { withModemUpdateLock } from "../../modules/network/state/device-lock.ts";

export async function configureModem(
	input: ModemConfigInput,
): Promise<ModemConfigOutput> {
	// Normalised (post-clamp) config the device actually persists.
	const roaming = input.roaming ?? false;
	const network = input.network ?? "";
	const autoconfig = input.autoconfig ?? false;
	const modemId = Number(input.device);

	// AWAITED, and its outcome is REPORTED. This used to dispatch the apply
	// fire-and-forget through `handleModems` and answer `{success: true}` no
	// matter what happened, so a refusal reached the operator as a save.
	// A concurrent call joins the one-slot trailing scheduler, so the pre-lock
	// value remains a refusal until this request's callback actually runs. Held
	// on an object
	// so the assignment inside the closure is visible to the check below.
	const state: {
		outcome: ModemConfigOutcome;
		applied: ModemConfigOutput["applied"];
	} = {
		outcome: { ok: false, reason: "device_busy" },
		applied: undefined,
	};

	const applyRadioConfig = async (): Promise<void> => {
		await withModemUpdateLock(async () => {
			state.outcome = await applyModemConfig({
				device: modemId,
				network_type: input.network_type,
				roaming,
				network,
				autoconfig,
				apn: input.apn,
				username: input.username,
				password: input.password,
			});

			if (shouldMockModems()) {
				const applied = normalizeModemConnectionFields(input, true);
				setMockModemConfig(input.device, {
					apn: applied.apn,
					network_type_active: input.network_type,
					roaming: applied.roaming,
				});

				const modem = getModem(modemId);
				if (modem) {
					modem.network_type.active = input.network_type;
					if (modem.config) {
						Object.assign(modem.config, applied);
					}
					broadcastModems({ [modemId]: true });
				}
				state.outcome = { ok: true, reconnected: false };
				state.applied = {
					device: input.device,
					network_type: input.network_type,
					...applied,
				};
			} else if (state.outcome.ok) {
				const modem = getModem(modemId);
				if (modem?.config && modem.network_type.active !== null) {
					const { conn: _conn, ...applied } = modem.config;
					// Snapshot while locked: later saves must not rewrite this receipt.
					state.applied = {
						device: String(modemId),
						network_type: modem.network_type.active,
						...applied,
					};
				}
			}
		});
	};

	const before = getModem(modemId)?.config;
	const guarded = await withJournaledModemMutation(
		modemStableKeyForId(modemId),
		"modem-config",
		{
			apn: before?.apn ?? "",
			username: before?.username ?? "",
			roaming: before?.roaming ?? false,
			network: before?.network ?? "",
			autoconfig: before?.autoconfig ?? false,
			network_type: getModem(modemId)?.network_type.active ?? "",
		},
		async () => {
			await applyRadioConfig();
			// EVERY typed refusal from `applyModemConfig` describes a write that
			// did NOT land — the profile write is verified and the bearer
			// tear-down is gated on a real change — so the pre-state is still
			// current and the armed entry is cancelled rather than left blocking
			// the device. Only a THROW leaves a state nobody can name, and the
			// journaled wrapper marks that `failed` on its own.
			return { confirmed: true, value: undefined };
		},
	);
	if (!guarded.ok) {
		return { success: false, error: guarded.refusal };
	}

	if (!state.outcome.ok) {
		return { success: false, error: state.outcome.reason };
	}
	if (state.applied === undefined) {
		return { success: false, error: "write_failed" };
	}

	// The usage policy is LOCAL durable state, not a modem write, so it is
	// applied outside the modem lock and only after the radio config landed —
	// a save that failed at the radio must not leave a meter bound half-changed.
	const policy = await applyUsagePolicyChange(input);
	if (!policy.ok) {
		return { success: false, error: policy.reason };
	}

	return {
		success: true,
		reconnected: state.outcome.reconnected,
		applied: {
			...state.applied,
			...(policy.policy.cycleDay !== undefined
				? { data_usage_cycle_day: policy.policy.cycleDay }
				: {}),
			...(policy.policy.thresholdBytes !== undefined
				? { data_usage_threshold_bytes: policy.policy.thresholdBytes }
				: {}),
		},
	};
}

/**
 * Persist the request's usage-policy fields, if it carries any.
 *
 * A request that mentions NEITHER field touches nothing and reports the policy
 * already on file — an APN-only save must not require the caller to restate a
 * meter bound it has no opinion about, and must not be refused on a device whose
 * pinned `@ceralive/modem-control` cannot write one.
 */
async function applyUsagePolicyChange(input: {
	device: string;
	data_usage_cycle_day?: number | null | undefined;
	data_usage_threshold_bytes?: number | null | undefined;
}): Promise<
	| { ok: true; policy: ModemUsagePolicy }
	| { ok: false; reason: ModemConfigRefusal }
> {
	const ifname = getModem(Number(input.device))?.ifname;
	const idPath = ifname !== undefined ? getModemIdPath(ifname) : undefined;
	const slotKey = usagePolicySlotKey(
		input.device,
		deriveModemStableKey(idPath),
	);
	const touchesPolicy =
		input.data_usage_cycle_day !== undefined ||
		input.data_usage_threshold_bytes !== undefined;
	if (!touchesPolicy) {
		return { ok: true, policy: getCachedUsagePolicy(slotKey) ?? {} };
	}
	const written = await writeUsagePolicy(slotKey, {
		...(input.data_usage_cycle_day !== undefined
			? { cycleDay: input.data_usage_cycle_day }
			: {}),
		...(input.data_usage_threshold_bytes !== undefined
			? { thresholdBytes: input.data_usage_threshold_bytes }
			: {}),
	});
	if (!written.ok) {
		return { ok: false, reason: written.reason };
	}
	broadcastModems();
	return { ok: true, policy: written.policy };
}
