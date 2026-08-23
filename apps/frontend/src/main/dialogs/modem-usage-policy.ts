/**
 * The data-usage POLICY form ↔ wire conversion, kept pure and rune-free.
 *
 * The policy is two numbers an operator sets; the wire carries bytes and a day
 * index. Everything fiddly about that round trip lives here so the dialog stays
 * declarative and the edge cases are unit-testable:
 *
 *  - The threshold is entered in the SAME unit the meter renders. `formatBytes`
 *    steps by 1024 while labelling the step "GB", so a threshold entered as "5"
 *    has to be 5 × 1024³ or the operator's own limit would read back as "4.7 GB"
 *    beside the bar it draws. Matching the rendered vocabulary beats being right
 *    about SI when the two are on screen together.
 *  - EMPTY IS A REAL VALUE, distinct from unchanged: it means "no limit", and it
 *    has to reach the wire as an explicit `null` so the device clears the stored
 *    policy rather than keeping the previous number.
 *  - …but EMPTY AND UNTOUCHED IS A THIRD THING, and conflating it with the second
 *    is how a partial save drops a bound the operator never looked at. See
 *    {@link diffUsagePolicyWireFields}.
 */

/** The dialog's editable representation. Empty string means "not set". */
export interface UsagePolicyForm {
	readonly cycleDay: string;
	readonly thresholdGb: string;
}

/**
 * The tri-state wire fields `modems.configure` accepts.
 *
 * BOTH FIELDS ARE OPTIONAL, and that optionality is the contract rather than
 * defensive typing: the device reads `undefined` as "leave the persisted bound
 * alone" and `null` as "clear it" (`apps/backend/.../usage-policy.ts`
 * `writeUsagePolicy`, and modem-stack's `setUsagePolicy` behind it). A shape
 * that could only ever say `number | null` can express two of the three states,
 * and the one it cannot express is the one an untouched field needs.
 */
export interface UsagePolicyWireFields {
	readonly data_usage_cycle_day?: number | null;
	readonly data_usage_threshold_bytes?: number | null;
}

const GB = 1024 ** 3;

/** Every selectable cycle day, in operator order. */
export const CYCLE_DAY_OPTIONS: readonly number[] = Array.from(
	{ length: 31 },
	(_, index) => index + 1,
);

/** Seed the form from the policy the device reports. */
export function readUsagePolicyForm(policy?: {
	cycle_day?: number;
	threshold_bytes?: number;
}): UsagePolicyForm {
	return {
		cycleDay: policy?.cycle_day === undefined ? "" : String(policy.cycle_day),
		thresholdGb:
			policy?.threshold_bytes === undefined
				? ""
				: formatThresholdGb(policy.threshold_bytes),
	};
}

/**
 * Bytes → the GB string the input shows.
 *
 * Trailing zeros are trimmed so a round 5 GiB reads "5" rather than "5.00" — an
 * operator who typed "5" must find "5" when they come back, or the field looks
 * like the device rewrote their answer.
 */
export function formatThresholdGb(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	const gb = bytes / GB;
	return String(Number(gb.toFixed(2)));
}

/** True when the entered threshold cannot become a non-negative byte count. */
export function isThresholdInvalid(thresholdGb: string): boolean {
	const trimmed = thresholdGb.trim();
	if (trimmed === "") return false;
	const parsed = Number(trimmed);
	return !Number.isFinite(parsed) || parsed < 0;
}

/**
 * Project the form onto the wire fields, stating BOTH, or `undefined` if invalid.
 *
 * This is the "the operator answered both questions" form, and it is what a
 * caller with no seeded baseline gets. It cannot express "leave this one alone",
 * so a dialog that has a baseline must use {@link diffUsagePolicyWireFields}.
 */
export function toUsagePolicyWireFields(
	form: UsagePolicyForm,
): UsagePolicyWireFields | undefined {
	if (isThresholdInvalid(form.thresholdGb)) return undefined;
	const day = parseCycleDay(form.cycleDay);
	if (day === INVALID) return undefined;
	return {
		data_usage_cycle_day: day,
		data_usage_threshold_bytes: parseThresholdBytes(form.thresholdGb),
	};
}

/**
 * The TRI-STATE projection: what changed, and nothing else.
 *
 * A field the operator did not touch is OMITTED, so the device leaves whatever
 * it has on file alone. That is not a nicety — the form is seeded once on the
 * open edge and is deliberately not live-synced, so a dialog opened before the
 * policy block arrived holds an empty cycle-day field for a modem that has one.
 * Stating that empty field as an explicit `null` would clear a bound the
 * operator never looked at, on a save they made about the threshold.
 *
 * Comparing against the SEEDED form rather than against the persisted policy is
 * what separates "still empty because nobody typed here" from "emptied on
 * purpose": only the second is a `null`, and only the seeded baseline can tell
 * them apart.
 */
export function diffUsagePolicyWireFields(
	seeded: UsagePolicyForm,
	current: UsagePolicyForm,
): UsagePolicyWireFields | undefined {
	if (isThresholdInvalid(current.thresholdGb)) return undefined;
	const day = parseCycleDay(current.cycleDay);
	if (day === INVALID) return undefined;

	const dayTouched = current.cycleDay.trim() !== seeded.cycleDay.trim();
	const thresholdTouched =
		current.thresholdGb.trim() !== seeded.thresholdGb.trim();

	return {
		...(dayTouched ? { data_usage_cycle_day: day } : {}),
		...(thresholdTouched
			? { data_usage_threshold_bytes: parseThresholdBytes(current.thresholdGb) }
			: {}),
	};
}

/** Sentinel for a cycle-day entry outside 1..31, kept off the `null` channel. */
const INVALID = Symbol("invalid-cycle-day");

function parseCycleDay(raw: string): number | null | typeof INVALID {
	const day = raw.trim();
	if (day === "") return null;
	const parsed = Number(day);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) return INVALID;
	return parsed;
}

function parseThresholdBytes(raw: string): number | null {
	const threshold = raw.trim();
	return threshold === "" ? null : Math.round(Number(threshold) * GB);
}
