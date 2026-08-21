import { z } from 'zod';

import { capabilityMutationRefusalSchema } from './modems.schema';

/**
 * The `fcc-auto-unlock` module's wire contract — a per-MODEL opt-in, and the
 * coverage catalog that decides whether the opt-in can do anything at all.
 *
 * The catalog below is a Rule-D MIRROR of `modem-stack`'s
 * `control/src/fcc/coverage.ts`, never a shared import — the same relationship
 * `usb-net-classifier.ts` has with `device-classifier.ts` in the other direction.
 * Both halves are pinned by their own tests, not by a path.
 *
 * IT LIVES IN THIS PACKAGE because three consumers must agree by construction: the
 * backend decides what may be WRITTEN, the frontend decides what is OFFERED, and
 * the operator copy decides what is CLAIMED. A UI-local copy of the catalog would
 * offer a toggle the write path refuses, which is precisely the class of lie the
 * capability framework exists to prevent.
 */

/**
 * `<vid>:<pid>` — 4 lowercase hex digits each. This is the EXACT filename
 * ModemManager's dispatcher looks for: `mm-dispatcher-fcc-unlock.c` builds
 * `g_strdup_printf("%04x:%04x", vid, pid)` and consults no other name, so a
 * vendor-only key would name a file that is never opened.
 */
export const FCC_UNLOCK_KEY_RE = /^[0-9a-f]{4}:[0-9a-f]{4}$/;
export const fccUnlockKeySchema = z.string().regex(FCC_UNLOCK_KEY_RE);

/**
 * ModemManager 1.24.2's COMPLETE shipped mapping — the pinned release this fleet
 * runs (`modem-stack/packaging/upstream-pins.yaml`). Fourteen entries; there are
 * no others. Full per-device matrix: `modem-stack/docs/FCC-UNLOCK-COVERAGE.md`.
 *
 * One silicon vendor can appear under several USB vendor ids — Sierra ships as
 * `1199` (its own), `03f0` (HP-branded) and `413c` (Dell-branded) — which is why
 * a vendor-keyed rule would be wrong in both directions.
 */
export const MM_FCC_UNLOCK_COVERAGE = [
	'03f0:4e1d',
	'105b:e0ab',
	'105b:e0c3',
	'1199:9079',
	'14c3:4d75',
	'1eac:1001',
	'1eac:1004',
	'1eac:1007',
	'2c7c:030a',
	'2c7c:0313',
	'2c7c:0314',
	'2c7c:0801',
	'413c:81a3',
	'413c:81a8',
] as const;

const COVERED = new Set<string>(MM_FCC_UNLOCK_COVERAGE);

/**
 * Fold a vid/pid pair into the dispatcher's key, or `undefined` when it is not a
 * pair of 4-hex ids. Case is folded and a `0x` prefix tolerated because sysfs and
 * udev disagree about both; NOTHING else is normalized, because a 3- or 5-digit id
 * is a different device rather than a sloppy spelling of this one.
 */
export function normalizeFccUnlockKey(
	vid: string | undefined,
	pid: string | undefined,
): string | undefined {
	if (vid === undefined || pid === undefined) return undefined;
	const fold = (raw: string): string => raw.trim().toLowerCase().replace(/^0x/, '');
	const key = `${fold(vid)}:${fold(pid)}`;
	return FCC_UNLOCK_KEY_RE.test(key) ? key : undefined;
}

/**
 * Does ModemManager ship an unlock procedure for this device?
 *
 * Three answers, none interchangeable. `absent` is a POSITIVE statement about the
 * device (well-formed ids that are not in the mapping) and hides the control;
 * `unknown` is a statement about the READ and leaves the ladder at `enabled`, so
 * the module is surfaced by nothing rather than declared impossible on hardware
 * that may well be covered.
 */
export function resolveFccUnlockCoverage(
	vid: string | undefined,
	pid: string | undefined,
): 'present' | 'absent' | 'unknown' {
	const key = normalizeFccUnlockKey(vid, pid);
	if (key === undefined) return 'unknown';
	return COVERED.has(key) ? 'present' : 'absent';
}

/**
 * The read a dialog opens on.
 *
 * `model_wide` is published as an EXPLICIT `true` rather than left implied,
 * because it is the one fact an operator has to be told BEFORE they act:
 * ModemManager's mechanism is a `<vid>:<pid>` symlink, so the toggle applies to
 * EVERY attached device matching that model. Two identical dongles cannot be
 * separated, and no per-unit refinement exists without changing ModemManager.
 */
export const fccUnlockStateSchema = z.object({
	/** The dispatcher key, absent when this modem's ids could not be read. */
	key: fccUnlockKeySchema.optional(),
	/** `unknown` means the READ failed — never that the device is uncovered. */
	coverage: z.enum(['present', 'absent', 'unknown']),
	/** The operator's persisted opt-in. Absent from the policy ⇒ `false`. */
	enabled: z.boolean(),
	/** Always `true`. See the note above — this is a disclosure, not a flag. */
	model_wide: z.literal(true),
	/**
	 * The re-probe an ALREADY-ENUMERATED modem needs for a change to take effect.
	 * ModemManager runs the dispatcher during modem initialization only.
	 */
	requires_reprobe: z.literal(true),
});
export type FccUnlockState = z.infer<typeof fccUnlockStateSchema>;

export const fccUnlockOptionsInputSchema = z.object({ device: z.string().min(1) }).strict();
export type FccUnlockOptionsInput = z.infer<typeof fccUnlockOptionsInputSchema>;

export const fccUnlockOptionsOutputSchema = z.union([
	z.object({ success: z.literal(true), state: fccUnlockStateSchema }),
	z.object({ success: z.literal(false), error: z.enum(['unknown_modem']) }),
]);
export type FccUnlockOptionsOutput = z.infer<typeof fccUnlockOptionsOutputSchema>;

/**
 * `.strict()` + `confirm: z.literal(true)` for the same reason `setUsbMode` is:
 * this write changes what a regulatory-locked radio does at every boot, so an
 * unknown extra key must be REJECTED rather than ignored, and an omitted or falsy
 * confirmation must never reach the handler.
 */
export const setFccUnlockInputSchema = z
	.object({
		device: z.string().min(1),
		enabled: z.boolean(),
		confirm: z.literal(true),
	})
	.strict();
export type SetFccUnlockInput = z.infer<typeof setFccUnlockInputSchema>;

/**
 * Why the write did not land, once the gate and the lease both let it through.
 *
 *   unknown_modem  — no modem answers to that selector.
 *   identity_unknown — the modem's USB ids could not be read, so there is no
 *                    dispatcher key to write. Refused rather than guessed: a
 *                    wrong key is a symlink for somebody else's hardware.
 *   not_covered    — ModemManager ships no procedure for this model. Persisting
 *                    `true` here would leave an enabled toggle that provably
 *                    cannot act, because the reconciler would skip it forever and
 *                    silently. DISABLING is never refused for this reason — a
 *                    fail-closed opt-OUT is not a thing.
 *   write_failed   — the policy file could not be written.
 *   unavailable_in_emulated_mode — there is no radio to re-probe. Checked ahead
 *                    of the streaming refusal, because answering `streaming_active`
 *                    on a dev host would be a lie about why.
 */
export const setFccUnlockErrorSchema = z.enum([
	'unknown_modem',
	'identity_unknown',
	'not_covered',
	'write_failed',
	'unavailable_in_emulated_mode',
]);
export type SetFccUnlockError = z.infer<typeof setFccUnlockErrorSchema>;

export const setFccUnlockOutputSchema = z.union([
	z.object({
		success: z.literal(true),
		state: fccUnlockStateSchema,
		/**
		 * Whether the modem was re-probed. FALSE for an unchanged write — the
		 * re-probe drops the bearer, so spending one on a no-op would cost an
		 * operator their link for nothing.
		 */
		reprobed: z.boolean(),
	}),
	z.object({ success: z.literal(false), error: setFccUnlockErrorSchema }),
	z.object({ success: z.literal(false), refusal: capabilityMutationRefusalSchema }),
]);
export type SetFccUnlockOutput = z.infer<typeof setFccUnlockOutputSchema>;
