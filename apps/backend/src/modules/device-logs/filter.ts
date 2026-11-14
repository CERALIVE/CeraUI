import {
	LOG_LEVELS,
	LOG_SOURCES,
	type LogFilter,
	type LogLevel,
} from "@ceraui/rpc/schemas";
import { SOURCE_UNITS } from "./catalog.ts";

const PRIORITIES: Readonly<Record<LogLevel, readonly number[]>> = {
	error: [0, 1, 2, 3],
	warning: [4],
	info: [5, 6],
	debug: [7],
};

/** Compile parsed filters into field matches for the reader's end-of-options boundary. */
export function compileFilter(
	{ sources = [], levels = [...LOG_LEVELS], text }: LogFilter,
	{ bootId }: { readonly bootId: string | null },
): { matches: string[]; residual: { text?: string } } {
	const boot = bootId === null ? [] : [`_BOOT_ID=${bootId}`];
	const allLevels = LOG_LEVELS.every((level) => levels.includes(level));
	const priorities = allLevels
		? []
		: LOG_LEVELS.filter((level) => levels.includes(level)).flatMap((level) =>
				PRIORITIES[level].map((priority) => `PRIORITY=${priority}`),
			);
	const common = [...boot, ...priorities];
	const units = LOG_SOURCES.filter((source) =>
		sources.includes(source),
	).flatMap((source) => SOURCE_UNITS[source]);
	const groups: string[][] = [];
	if (sources.length === 0) groups.push(common);
	if (units.length > 0)
		groups.push([...common, ...units.map((unit) => `_SYSTEMD_UNIT=${unit}`)]);
	if (sources.includes("kernel")) groups.push([...common, "_TRANSPORT=kernel"]);
	// Suppression notices must survive a severity filter so gaps remain visible.
	if (sources.length > 0 || !allLevels) {
		groups.push([...boot, "MESSAGE_ID=a596d6fe7bfa4994828e72309e95d61e"]);
	}
	return {
		matches: groups.flatMap((group, index) =>
			index === 0 ? group : ["+", ...group],
		),
		residual: text === undefined ? {} : { text },
	};
}
