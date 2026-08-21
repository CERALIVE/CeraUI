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
 */

/** The dialog's editable representation. Empty string means "not set". */
export interface UsagePolicyForm {
	readonly cycleDay: string;
	readonly thresholdGb: string;
}

/** The tri-state wire fields `modems.configure` accepts. */
export interface UsagePolicyWireFields {
	readonly data_usage_cycle_day: number | null;
	readonly data_usage_threshold_bytes: number | null;
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

/** Project the form onto the tri-state wire fields, or `undefined` if invalid. */
export function toUsagePolicyWireFields(
	form: UsagePolicyForm,
): UsagePolicyWireFields | undefined {
	if (isThresholdInvalid(form.thresholdGb)) return undefined;
	const day = form.cycleDay.trim();
	const parsedDay = day === "" ? null : Number(day);
	if (
		parsedDay !== null &&
		(!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31)
	) {
		return undefined;
	}
	const threshold = form.thresholdGb.trim();
	return {
		data_usage_cycle_day: parsedDay,
		data_usage_threshold_bytes:
			threshold === "" ? null : Math.round(Number(threshold) * GB),
	};
}
