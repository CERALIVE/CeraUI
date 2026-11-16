/**
 * What the boot picker shows for each boot of `logs.boots()`. The shutdown mark
 * is the device's own classification and is never derived here; only the
 * "changed" tag is computed, and only from two recorded values.
 */
import type { LogBootInfo } from "@ceraui/rpc/schemas";

export interface BootRow {
	readonly boot: LogBootInfo;
	readonly osImage: string | null;
	readonly slot: string | null;
	readonly changed: boolean;
}

const osImage = (boot: LogBootInfo | undefined) =>
	boot?.versions?.osImage ?? null;
const slot = (boot: LogBootInfo | undefined) => boot?.versions?.slot ?? null;

// An unrecorded value on either side is not a change.
function differs(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && a !== b;
}

/** The device lists boots newest first, so the boot before row i is row i + 1. */
export function bootRows(boots: readonly LogBootInfo[]): BootRow[] {
	return boots.map((boot, index) => {
		const previous = boots[index + 1];
		return {
			boot,
			osImage: osImage(boot),
			slot: slot(boot),
			changed:
				differs(osImage(boot), osImage(previous)) ||
				differs(slot(boot), slot(previous)),
		};
	});
}

/**
 * Seconds included: the boots of a boot loop can start seconds apart. The day
 * period (AM, ص, 오전) is held to its time with a no-break space, as CLDR
 * intends; browsers emit a plain space there, so a line could end between them.
 */
export function formatBootTime(ts: number, locale: string): string {
	const parts = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "medium",
	}).formatToParts(ts);
	return parts
		.map((part, index) => {
			const near = [parts[index - 1]?.type, parts[index + 1]?.type];
			const holdsPeriod =
				near.includes("dayPeriod") &&
				(near.includes("hour") || near.includes("second"));
			return holdsPeriod ? part.value.replace(/\s/g, "\u00a0") : part.value;
		})
		.join("");
}

export function pickerKeyTarget(
	key: string,
	index: number,
	count: number,
): number | undefined {
	switch (key) {
		case "ArrowDown":
			return Math.min(index + 1, count - 1);
		case "ArrowUp":
			return Math.max(index - 1, 0);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return undefined;
	}
}
