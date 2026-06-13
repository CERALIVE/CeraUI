/**
 * HUD SoC telemetry parsing — pure, rune-free.
 *
 * Parses the SoC temperature / voltage / current sensor readings, which arrive
 * as numbers or unit-suffixed strings, into normalised numeric values. Never
 * throws or yields NaN — returns `null` on any unparseable input.
 */

/**
 * Parse a numeric reading out of a sensor value that may be a number or a
 * unit-suffixed string (e.g. "43.2°C", "5.1 V"). Returns `null` on failure
 * rather than throwing or yielding NaN.
 */
export function parseSensorNumber(
	raw: string | number | null | undefined,
): number | null {
	if (raw == null) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	const match = raw.match(/-?\d+(?:\.\d+)?/);
	if (!match) return null;
	const n = Number.parseFloat(match[0]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse a current reading and normalise to Amps. Values reported in
 * milliamps (e.g. "1500 mA") are converted to A.
 */
export function parseCurrentAmps(
	raw: string | number | null | undefined,
): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*a/i.test(raw)) return n / 1000;
	return n;
}

/**
 * Parse a voltage reading and normalise to Volts. Values reported in
 * millivolts (e.g. "5100 mV") are converted to V.
 */
export function parseVolts(
	raw: string | number | null | undefined,
): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*v/i.test(raw)) return n / 1000;
	return n;
}
