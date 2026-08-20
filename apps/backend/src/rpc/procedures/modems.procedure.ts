/**
 * Modems Procedures
 * Wraps existing modem logic from modules/modems/
 */

import {
	deriveModemStableKey,
	fccUnlockOptionsInputSchema,
	fccUnlockOptionsOutputSchema,
	isCapabilityGateEnabled,
	type ModemConfigRefusal,
	type ModemMutationRefusal,
	modemBandsInputSchema,
	modemBandsOutputSchema,
	modemConfigInputSchema,
	modemConfigOutputSchema,
	modemGpsInputSchema,
	modemGpsOutputSchema,
	modemListSchema,
	modemMutationAckInputSchema,
	modemMutationAckOutputSchema,
	modemMutationDecommissionInputSchema,
	modemMutationListOutputSchema,
	modemMutationRebaselineInputSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	modemSmsInputSchema,
	modemSmsOutputSchema,
	modemUssdInputSchema,
	modemUssdOutputSchema,
	setFccUnlockInputSchema,
	setFccUnlockOutputSchema,
	setFiveGPreferenceInputSchema,
	setFiveGPreferenceOutputSchema,
	setModemBandsInputSchema,
	setModemBandsOutputSchema,
	setModemGpsInputSchema,
	setModemGpsOutputSchema,
	setUsbModeInputSchema,
	setUsbModeOutputSchema,
	simPin2UnlockInputSchema,
	simPin2UnlockOutputSchema,
	simPukUnlockInputSchema,
	simPukUnlockOutputSchema,
	simUnlockInputSchema,
	simUnlockOutputSchema,
	usbModeOptionsInputSchema,
	usbModeOptionsOutputSchema,
	ussdCancelInputSchema,
	ussdInitiateInputSchema,
	ussdRespondInputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { logger } from "../../helpers/logger.ts";
import { setMockModemConfig } from "../../mocks/mock-service.ts";
import {
	mockAttemptSimPin2Unlock,
	mockAttemptSimPukUnlock,
	mockAttemptSimUnlock,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import { getConfig } from "../../modules/config.ts";
import {
	refreshBandCapability,
	resolveBandSku,
} from "../../modules/modems/band-capability.ts";
import { applyBandLock, unlockedFrom } from "../../modules/modems/band-lock.ts";
import {
	readFccUnlockState,
	setFccUnlockEnabled,
} from "../../modules/modems/fcc-unlock.ts";
import { applyFiveGPreference } from "../../modules/modems/five-g-apply.ts";
import { readModemGps, setModemGps } from "../../modules/modems/gps.ts";
import {
	mmGetModemPorts,
	type SimPukUnlockResult,
	type SimUnlockResult,
	unlockSimPin,
	unlockSimPuk,
} from "../../modules/modems/mmcli.ts";
import { readSmsInbox } from "../../modules/modems/mmcli-sms.ts";
import {
	broadcastModems,
	buildModemsWireMessage,
} from "../../modules/modems/modem-status.ts";
import { getModemIdPath } from "../../modules/modems/modem-wire-producer.ts";
import {
	applyModemConfig,
	handleModems,
	type ModemConfigOutcome,
} from "../../modules/modems/modems.ts";
import { getModem } from "../../modules/modems/modems-state.ts";
import {
	acknowledgeMutation,
	decommissionMutation,
	rebaselineMutation,
} from "../../modules/modems/mutation-acknowledge.ts";
import { currentMutationBlocks } from "../../modules/modems/mutation-blocks.ts";
import {
	modemStableKeyForId,
	modemStableKeyForMmTarget,
} from "../../modules/modems/mutation-identity.ts";
import {
	withJournaledModemMutation,
	withModemMutation,
} from "../../modules/modems/mutation-lease.ts";
import {
	type SimPin2UnlockResult,
	unlockSimPin2,
} from "../../modules/modems/sim-pin2.ts";
import { clearSimPin, storeSimPin } from "../../modules/modems/sim-secrets.ts";
import {
	getCachedUsagePolicy,
	type ModemUsagePolicy,
	usagePolicySlotKey,
	writeUsagePolicy,
} from "../../modules/modems/usage-policy.ts";
import { resolveUsbModeOptions } from "../../modules/modems/usb-mode-certification.ts";
import {
	getUsbModeDispatchDeps,
	runUsbModeTransition,
} from "../../modules/modems/usb-mode-transition.ts";
import {
	cancelModemUssd,
	initiateModemUssd,
	readModemUssd,
	respondModemUssd,
} from "../../modules/modems/ussd.ts";
import { withModemUpdateLock } from "../../modules/network/state/device-lock.ts";
import { isRecoveryPending } from "../../modules/streaming/recovery-barrier.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { isRealDevice } from "../../modules/system/device-detection.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import { cellularReadyMiddleware } from "../middleware/cellular.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

// EVERY modem procedure builds from this, never from `authedProcedure` directly:
// the readiness gate has to be uniform, because a single ungated procedure is one
// that reads a half-initialised dbus backend during the init window.
export const modemProcedure = authedProcedure.use(cellularReadyMiddleware);

/**
 * Get all modems procedure
 */
export const getAllModemsProcedure = modemProcedure
	.output(modemListSchema)
	.handler(() => {
		return modemListSchema.parse(buildModemsWireMessage());
	});

/**
 * The mutation-safety refusals are members of `modemConfigRefusalSchema`, so the
 * mapping is an identity — declared rather than inlined so the type system fails
 * the build if the two vocabularies are ever allowed to drift apart.
 */
function configRefusalFor(refusal: ModemMutationRefusal): ModemConfigRefusal {
	return refusal;
}

/**
 * Configure modem procedure
 */
export const configureModemProcedure = modemProcedure
	.input(modemConfigInputSchema)
	.output(modemConfigOutputSchema)
	.handler(async ({ input }) => {
		// Normalised (post-clamp) config the device actually persists.
		const roaming = input.roaming ?? false;
		const network = input.network ?? "";
		const autoconfig = input.autoconfig ?? false;
		const modemId = Number(input.device);

		// AWAITED, and its outcome is REPORTED. This used to dispatch the apply
		// fire-and-forget through `handleModems` and answer `{success: true}` no
		// matter what happened, so a refusal reached the operator as a save.
		// A re-entrant call is DROPPED by the lock rather than queued, so the
		// pre-lock value has to be the refusal: leaving it optimistic would make a
		// dropped apply indistinguishable from an applied one. Held on an object
		// so the assignment inside the closure is visible to the check below.
		const state: { outcome: ModemConfigOutcome } = {
			outcome: { ok: false, reason: "device_busy" },
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
					setMockModemConfig(input.device, {
						apn: input.apn,
						network_type_active: input.network_type,
						roaming,
					});

					const modem = getModem(modemId);
					if (modem) {
						modem.network_type.active = input.network_type;
						if (modem.config) {
							modem.config.apn = input.apn;
							modem.config.username = input.username;
							modem.config.password = input.password;
							modem.config.roaming = roaming;
							modem.config.network = network;
							modem.config.autoconfig = autoconfig;
						}
						broadcastModems({ [modemId]: true });
					}
					state.outcome = { ok: true, reconnected: false };
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
			return { success: false, error: configRefusalFor(guarded.refusal) };
		}

		if (!state.outcome.ok) {
			return { success: false, error: state.outcome.reason };
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
				device: input.device,
				network_type: input.network_type,
				roaming,
				network,
				autoconfig,
				apn: input.apn,
				username: input.username,
				password: input.password,
				...(policy.policy.cycleDay !== undefined
					? { data_usage_cycle_day: policy.policy.cycleDay }
					: {}),
				...(policy.policy.thresholdBytes !== undefined
					? { data_usage_threshold_bytes: policy.policy.thresholdBytes }
					: {}),
			},
		};
	});

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

/**
 * Scan modem networks procedure
 */
export const scanModemProcedure = modemProcedure
	.input(modemScanInputSchema)
	.output(modemScanOutputSchema)
	.handler(async ({ input, context }) => {
		// A 3GPP network scan drops the modem's registration for its duration, so
		// it takes the mutation lease like every other disruptive path — it is not
		// journaled, because it restores itself and has no pre-state to put back.
		const guarded = await withModemMutation(
			modemStableKeyForId(Number(input.device)),
			async () => {
				await withModemUpdateLock(async () => {
					handleModems(context.ws as unknown as import("ws").default, {
						scan: { device: String(input.device) },
					});
				});
			},
		);
		return guarded.ok
			? { success: true }
			: { success: false, mutationRefusal: guarded.refusal };
	});

/**
 * Submit a SIM PIN to unlock a PIN-locked modem.
 *
 * Runs under `withModemUpdateLock` so the unlock is serialized against the
 * modem update loop — the PIN is submitted before any (re)registration poll can
 * race it. In mock/dev mode there is no PIN-locked hardware, so we route the
 * submit through the deterministic mock SIM state machine
 * ({@link mockAttemptSimUnlock}) — the `modem-pin-locked` scenario seeds a
 * PIN-locked modem (fixture PIN "0000") so the full unlock/PUK flow works
 * end-to-end in dev. The `remember`/`storeSimPin`/`clearSimPin` persistence
 * branch is real-device only — it never runs under mocks (no `/run/ceralive`
 * writes on a dev host).
 */
export const unlockSimProcedure = modemProcedure
	.input(simUnlockInputSchema)
	.output(simUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return mockAttemptSimUnlock(input.modemPath, input.pin);
		}

		let result: SimUnlockResult = { state: "error" };
		const guarded = await withModemMutation(
			modemStableKeyForMmTarget(input.modemPath),
			async () => {
				await withModemUpdateLock(async () => {
					result = await unlockSimPin(input.modemPath, input.pin);
				});
			},
		);
		if (!guarded.ok) {
			return { state: "error" as const, mutationRefusal: guarded.refusal };
		}

		// Opt-in "remember PIN": persist ONLY a confirmed-correct PIN to the
		// chmod-600 tmpfs secrets file (never config.json) so boot auto-unlock has
		// it. `remember: false` opts back out and clears any stored PIN; an absent
		// flag leaves the stored PIN untouched. Persistence never fails the unlock.
		if (
			(result as SimUnlockResult).state === "success" &&
			input.remember !== undefined
		) {
			try {
				if (input.remember) {
					await storeSimPin(input.pin);
				} else {
					await clearSimPin();
				}
			} catch (err) {
				logger.warn(`SIM PIN remember toggle failed: ${err}`);
			}
		}

		return result;
	});

/**
 * Submit a SIM PUK + new PIN to recover a PUK-locked modem.
 *
 * The companion to {@link unlockSimProcedure} for the case where wrong-PIN
 * attempts are exhausted and only the carrier PUK can restore the SIM. Runs
 * under `withModemUpdateLock` so the submit is serialized against the modem
 * update loop. In mock/dev mode there is no PUK-locked hardware, so we route the
 * submit through the deterministic mock SIM state machine
 * ({@link mockAttemptSimPukUnlock}) — exhausting the PIN attempts in the
 * `modem-pin-locked` scenario trips the SIM to PUK-locked, and the fixture PUK
 * "12345678" recovers it, so the full PUK flow works end-to-end in dev.
 */
export const unlockSimPukProcedure = modemProcedure
	.input(simPukUnlockInputSchema)
	.output(simPukUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return mockAttemptSimPukUnlock(input.modemPath, input.puk);
		}

		let result: SimPukUnlockResult = { success: false, error: "error" };
		const guarded = await withModemMutation(
			modemStableKeyForMmTarget(input.modemPath),
			async () => {
				await withModemUpdateLock(async () => {
					result = await unlockSimPuk(input.modemPath, input.puk, input.newPin);
				});
			},
		);
		if (!guarded.ok) {
			return {
				success: false,
				error: "error" as const,
				mutationRefusal: guarded.refusal,
			};
		}
		return result;
	});

/**
 * Verify a SIM's PIN2 — the Fixed-Dialling-Number / call-cost credential.
 *
 * Deliberately NOT a variant of {@link unlockSimProcedure}. PIN2 does not gate
 * registration or data (ModemManager never marks such a modem LOCKED), and it
 * cannot travel over mmcli at all, because ModemManager exposes no PIN2
 * operation — the submit runs over libqmi's UIM service instead. The full
 * evidence for both claims is in `modules/modems/sim-pin2.ts`.
 *
 * Runs under `withModemUpdateLock` for the same reason the PIN1 path does: the
 * submit must not race the modem update loop. The QMI device node is resolved
 * from ModemManager's own port list rather than assumed, so on a multi-modem
 * board one SIM's PIN2 can never be submitted against another's card.
 */
export const unlockSimPin2Procedure = modemProcedure
	.input(simPin2UnlockInputSchema)
	.output(simPin2UnlockOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			return mockAttemptSimPin2Unlock(input.modemPath, input.pin2);
		}

		// The lease is taken BEFORE the port read, not after: reading ModemManager's
		// port list is the first step of this transaction, and a device whose ports
		// cannot be read must still answer WHY it refused rather than collapsing
		// into a bare `error` that hides a held lease.
		let result: SimPin2UnlockResult = { state: "error" };
		const guarded = await withModemMutation(
			modemStableKeyForMmTarget(input.modemPath),
			async () => {
				const ports = await mmGetModemPorts(input.modemPath);
				if (ports === undefined) return;
				await withModemUpdateLock(async () => {
					result = await unlockSimPin2(input.modemPath, input.pin2, ports);
				});
			},
		);
		if (!guarded.ok) {
			return { state: "error" as const, mutationRefusal: guarded.refusal };
		}

		if ((result as SimPin2UnlockResult).state === "success") {
			// EXACTLY ONE re-discovery, the `modems.setUsbMode` precedent: the
			// regular loop only broadcasts every 30 s, so without this a verified
			// PIN2 leaves the row claiming a lock for up to half a minute. Runs
			// after the update lock is released — it is not reentrant.
			const { discoverModems } = await import(
				"../../modules/modems/modem-update-loop.ts"
			);
			await discoverModems();
		}

		return result;
	});

/**
 * Read a modem's stored SMS inbox, newest first and capped.
 *
 * `modemProcedure`-gated like every modem procedure, and READ-ONLY for good:
 * the only mmcli verbs behind it are `--messaging-list-sms` and a per-message
 * `-s <path>` read, both of which are already-available reads against the same
 * ModemManager daemon either cellular backend talks to. It therefore adds no
 * modem-control capability at all, which is why it needs no provisioning gate,
 * no streaming interlock, and no confirmation — and why a send/delete sibling
 * would be a categorically different change rather than an increment.
 *
 * A refusal is NEVER flattened into an empty inbox: `{success: true, messages:
 * []}` means this modem has an inbox and it is empty, and nothing else.
 */
export const getModemSmsProcedure = modemProcedure
	.input(modemSmsInputSchema)
	.output(modemSmsOutputSchema)
	.handler(async ({ input }) => {
		const result = await readSmsInbox(input.device);
		if (!result.ok) {
			return { success: false, error: result.reason };
		}
		return { success: true, messages: result.messages };
	});

/**
 * Read GNSS capability, whether it is on, and the CURRENT fix.
 *
 * It takes NO mutation lease — it mutates nothing, the `modems.getAll`/`getSms`
 * rule — but it is NOT a pure read either: it advances the bounded no-fix and
 * stale-fix state machine, which is what makes an antenna-less modem reach an
 * honest terminal `no-fix` instead of leaving a caller polling a spinner.
 *
 * A refusal is never flattened into a `no-fix` state: `unsupported` means this
 * modem has no GNSS receiver at all, and rendering that as "searching" would
 * leave an operator waiting on hardware that will never answer.
 */
export const getModemGpsProcedure = modemProcedure
	.input(modemGpsInputSchema)
	.output(modemGpsOutputSchema)
	.handler(async ({ input }) => {
		const result = await readModemGps(input.device);
		if (!result.success) {
			return { success: false, error: result.error };
		}
		return { success: true, status: result.status, state: result.state };
	});

/**
 * Switch the modem's GNSS sources on or off.
 *
 * Runs under the capability-module mutation lease and is deliberately NOT
 * journaled — `Location.Setup` touches no bearer, so there is no bond link a
 * crash-surviving rollback would have to restore. Disabling CLEARS the held fix.
 */
export const setModemGpsProcedure = modemProcedure
	.input(setModemGpsInputSchema)
	.output(setModemGpsOutputSchema)
	.handler(({ input }) => setModemGps(input.device, input.enabled));

/**
 * Which USB composition modes this modem may be offered — a pure READ, and the
 * gate that decides whether a switch control renders at all.
 *
 * It takes NO mutation lease (it mutates nothing — the `modems.getAll`/`getSms`
 * rule) and it runs through {@link getUsbModeDispatchDeps}, so the set it offers
 * is resolved by the SAME identity resolver and matched against the SAME catalog
 * `setUsbMode` will gate on.
 *
 * It does NOT answer the provisioning question. That gate is a device SETTING
 * the operator can turn back on, so its control renders disabled-with-reason
 * rather than absent; folding it in here would withdraw a control that is merely
 * blocked and make the two states indistinguishable.
 */
export const getUsbModeOptionsProcedure = modemProcedure
	.input(usbModeOptionsInputSchema)
	.output(usbModeOptionsOutputSchema)
	.handler(async ({ input }) => {
		if (shouldMockModems()) {
			const { getMockUsbModeOptions } = await import(
				"../../mocks/providers/modems.ts"
			);
			return getMockUsbModeOptions(input.device);
		}
		if (!(await isRealDevice())) {
			return { certified: [], suppressed: "unavailable_in_emulated_mode" };
		}
		return resolveUsbModeOptions(input.device, getUsbModeDispatchDeps());
	});

/**
 * Whether this modem's MODEL has an FCC-unlock procedure, and whether the
 * operator opted in — a pure READ, taking no lease (the `modems.getAll`/`getSms`
 * rule) and resolving through the SAME catalog the write path gates on.
 */
export const getFccUnlockProcedure = modemProcedure
	.input(fccUnlockOptionsInputSchema)
	.output(fccUnlockOptionsOutputSchema)
	.handler(async ({ input }) => readFccUnlockState(input.device));

/**
 * Opt a MODEL in or out of ModemManager's FCC auto-unlock.
 *
 * The gate order mirrors `setUsbMode`'s and is the contract: the emulated-mode
 * check runs before the streaming one because a dev host has no radio to
 * re-probe either way, and answering `streaming_active` there would be a lie
 * about why. Everything past those two — the capability gate, the per-device
 * lease, the durable journal, the coverage refusal — lives in
 * `modules/modems/fcc-unlock.ts`, where the identity behind the selector is
 * resolved once and used for all of them.
 */
export const setFccUnlockProcedure = modemProcedure
	.input(setFccUnlockInputSchema)
	.output(setFccUnlockOutputSchema)
	.handler(async ({ input }) => {
		if (!(await isRealDevice())) {
			return { success: false, error: "unavailable_in_emulated_mode" } as const;
		}
		if (getIsStreaming()) {
			return { success: false, refusal: "streaming_active" } as const;
		}
		try {
			return await setFccUnlockEnabled(input.device, input.enabled);
		} catch (err) {
			logger.error(
				`modems.setFccUnlock(${input.device} → ${input.enabled}) threw`,
				{ module: "modems", err },
			);
			return { success: false, error: "write_failed" } as const;
		}
	});

/**
 * Switch a modem's USB composition mode.
 *
 * The gate order below is the contract, not an implementation detail. The
 * provisioning check runs FIRST and at the RPC layer, so a device that has never
 * been provisioned refuses a direct RPC call exactly as it refuses a UI one —
 * hiding the control would only hide it from the UI. The emulated-mode check runs
 * before the streaming check because there is no hardware to transition either
 * way, and answering `streaming_active` on a dev host would be a lie about why.
 *
 * The interlock lease is the FOURTH gate and covers a window `getIsStreaming()`
 * structurally cannot: a stream that has been ADMITTED but has not yet reached
 * PLAYING has already spawned its sender against a link list a re-enumeration is
 * about to invalidate. The two gates are kept side by side because they cover
 * DISJOINT windows, and both answer the same `streaming_active` token — from the
 * operator's side "a stream is starting" and "a stream is running" call for the
 * same action.
 *
 * Everything past the lease is {@link runUsbModeTransition}: identify, then
 * certify against the catalog, and only then touch the transition engine. A
 * dependency that throws in there is caught HERE rather than there, so the
 * lease's `finally` release is exercised by a real escaping throw.
 */
export const setUsbModeProcedure = modemProcedure
	.input(setUsbModeInputSchema)
	.output(setUsbModeOutputSchema)
	.handler(async ({ input }) => {
		if (getConfig().modem_provisioning !== true) {
			return { success: false, error: "provisioning_disabled" };
		}

		if (!(await isRealDevice())) {
			return { success: false, error: "unavailable_in_emulated_mode" };
		}

		if (getIsStreaming()) {
			return { success: false, error: "streaming_active" };
		}

		try {
			// The per-device mutation lease is taken INSIDE the transition, because
			// it can only be keyed once the physical identity behind this modem id
			// has been resolved — and an unresolvable identity is its own refusal.
			return await runUsbModeTransition(input.device, input.mode);
		} catch (err) {
			logger.error(
				`modems.setUsbMode(${input.device} → ${input.mode}) threw before the transaction completed`,
				{ module: "modems", err },
			);
			return {
				success: false,
				error: "transition_failed",
				reason: "transaction_error",
			};
		}
	});

/**
 * Rank 5G against LTE on a modem that advertises both.
 *
 * There is deliberately NO gate here beyond `modemProcedure`'s. Every one this
 * write needs already lives inside `applyFiveGPreference`, and putting a second
 * copy at the RPC layer is how two guards drift into disagreeing:
 *
 *   - the FEATURE GATE and the per-modem capability check are
 *     `withCapabilityModuleMutation`'s, and they run on a pure read before a
 *     lease is taken or anything is journaled;
 *   - the streaming refusal and the per-device lease are the shared
 *     mutation-safety contract's, reached through that same helper;
 *   - the catalog check is the module's own, and it runs FIRST, so a posture this
 *     radio never advertised never contends for a device lease.
 *
 * The emulated-mode case needs no branch either: a dev host has no modem for
 * `resolveModemIndex` to find, so it answers the honest `unknown_modem` rather
 * than a claim about hardware it does not have.
 */
export const setFiveGPreferenceProcedure = modemProcedure
	.input(setFiveGPreferenceInputSchema)
	.output(setFiveGPreferenceOutputSchema)
	.handler(({ input }) => applyFiveGPreference(input.device, input.preference));

/**
 * The operator surface for a device the mutation journal is holding blocked.
 *
 * `replayComplete` rides the same read as the blocks because a UI cannot honestly
 * render "nothing is wrong" while replay is still deciding.
 */
export const listMutationBlocksProcedure = modemProcedure
	.output(modemMutationListOutputSchema)
	.handler(() => ({
		replayComplete: !isRecoveryPending(),
		blocks: [...currentMutationBlocks()],
	}));

/**
 * Acknowledge a failed mutation. NEITHER mode is a dismissal — see
 * `modules/modems/mutation-acknowledge.ts` for why a bare alert-dismiss must
 * never unblock a device whose true state is unknown.
 */
export const acknowledgeMutationProcedure = modemProcedure
	.input(modemMutationAckInputSchema)
	.output(modemMutationAckOutputSchema)
	.handler(({ input }) => acknowledgeMutation(input.stableKey, input.mode));

export const decommissionMutationProcedure = modemProcedure
	.input(modemMutationDecommissionInputSchema)
	.output(modemMutationAckOutputSchema)
	.handler(({ input }) => decommissionMutation(input.stableKey));

export const rebaselineMutationProcedure = modemProcedure
	.input(modemMutationRebaselineInputSchema)
	.output(modemMutationAckOutputSchema)
	.handler(({ input }) => rebaselineMutation(input.stableKey));

/**
 * Which bands this modem advertises, uses, and may be OFFERED — a pure READ.
 *
 * It takes NO mutation lease (the `modems.getAll`/`getSms` rule) and it is the
 * SAME resolution `setBands` gates on, so a band is never rendered that the
 * device would refuse to lock to. It also refreshes the capability snapshot the
 * modem wire row's `capability_modules` entry is built from: the wire build is
 * synchronous and cannot await an mmcli read, so this — the surface the UI asks
 * first — is where the async read happens.
 *
 * `uncertified` is a REFUSAL rather than an empty offer list, and the two are
 * not the same fact: an empty `offerable` on a certified modem would mean the
 * catalog narrowed the set to nothing, while `uncertified` means nobody has
 * proven this model+firmware can be unlocked again after being locked.
 */
export const getModemBandsProcedure = modemProcedure
	.input(modemBandsInputSchema)
	.output(modemBandsOutputSchema)
	.handler(async ({ input }) => {
		if (!isCapabilityGateEnabled(getConfig().modem_capabilities, "band-lock")) {
			return { success: false, error: "module_disabled" as const };
		}
		const identity = await resolveBandSku(input.device);
		if (identity === undefined) {
			return { success: false, error: "unknown_modem" as const };
		}
		const snapshot = await refreshBandCapability(
			input.device,
			identity.stableKey,
		);
		if (snapshot.capability === "unknown") {
			return { success: false, error: "read_failed" as const };
		}
		if (snapshot.capability === "absent") {
			return { success: false, error: "unsupported" as const };
		}
		if (!snapshot.certified) {
			return { success: false, error: "uncertified" as const };
		}
		return {
			success: true,
			bands: {
				supported: [...snapshot.supported],
				current: [...snapshot.current],
				offerable: [...snapshot.offerable],
				unlocked: unlockedFrom(snapshot.current),
			},
		};
	});

/**
 * Lock the modem to a band selection, or release the lock with `['any']`.
 *
 * Every safety property lives one layer down in {@link applyBandLock}, which
 * routes through the SHARED capability-mutation helper rather than re-deriving
 * a gate here — that is what keeps the feature gate, the per-device lease, the
 * reciprocal streaming refusal and the durable journal as ONE mechanism. This
 * handler's whole job is to hand the typed outcome to the wire and to fire the
 * single confirming re-discovery, the `setUsbMode` precedent: the regular loop
 * broadcasts every 30 s, so without it a landed band change leaves the row
 * stale for up to half a minute.
 */
export const setModemBandsProcedure = modemProcedure
	.input(setModemBandsInputSchema)
	.output(setModemBandsOutputSchema)
	.handler(async ({ input }) => {
		if (!(await isRealDevice())) {
			return { success: false, error: "unsupported" as const };
		}
		const outcome = await applyBandLock(input.device, input.bands);
		if (outcome.status !== undefined) {
			const { discoverModems } = await import(
				"../../modules/modems/modem-update-loop.ts"
			);
			await discoverModems();
		}
		return outcome;
	});

/**
 * The gated USSD module's READ: does this modem expose USSD, and what session is
 * it holding.
 *
 * Takes NO mutation lease — it mutates nothing, the `modems.getAll` / `getSms`
 * rule — and it does NOT answer the feature-gate question. That gate is a device
 * SETTING an operator can turn back on, so its control renders
 * disabled-with-reason rather than absent; folding it in here would make a
 * merely-disabled module indistinguishable from an unsupported one.
 */
export const getModemUssdProcedure = modemProcedure
	.input(modemUssdInputSchema)
	.output(modemUssdOutputSchema)
	.handler(({ input }) => readModemUssd(input.device));

/**
 * The three USSD verbs.
 *
 * They are ONE state machine rather than three independent calls: a USSD
 * dialogue is a scarce network-side resource, so a verb that is illegal for the
 * session's current state is refused with its own typed reason and dispatches
 * nothing at all. The feature gate and the per-device mutation lease are taken
 * INSIDE the module, keyed on the physical identity behind the modem id — an
 * unresolvable identity is its own refusal.
 */
export const ussdInitiateProcedure = modemProcedure
	.input(ussdInitiateInputSchema)
	.output(modemUssdOutputSchema)
	.handler(({ input }) => initiateModemUssd(input.device, input.ussdCommand));

export const ussdRespondProcedure = modemProcedure
	.input(ussdRespondInputSchema)
	.output(modemUssdOutputSchema)
	.handler(({ input }) => respondModemUssd(input.device, input.ussdResponse));

export const ussdCancelProcedure = modemProcedure
	.input(ussdCancelInputSchema)
	.output(modemUssdOutputSchema)
	.handler(({ input }) => cancelModemUssd(input.device));
