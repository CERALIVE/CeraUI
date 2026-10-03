import type { UpdateSettings } from "@ceraui/rpc/schemas";

export type IdleBlocker =
	| "stream"
	| "preview"
	| "remote"
	| "ui"
	| "startLease"
	| "schedule"
	| "activity-unknown";

export type IdleActivity = Readonly<
	Record<"stream" | "preview" | "remote" | "ui" | "startLease", number | null>
>;

export type IdleEvaluation = {
	readonly idle: boolean;
	readonly since: number | null;
	readonly blockers: readonly IdleBlocker[];
};

const ACTIVITY_KEYS = [
	"stream",
	"preview",
	"remote",
	"ui",
	"startLease",
] as const;

export function evaluateIdle(input: {
	readonly now: number;
	readonly lastActivity: IdleActivity;
	readonly schedule: UpdateSettings["schedule"];
	readonly idleMinutes: number;
}): IdleEvaluation {
	const { now, lastActivity, schedule, idleMinutes } = input;
	const observations = ACTIVITY_KEYS.flatMap((key) => {
		const at = lastActivity[key];
		return at !== null && Number.isFinite(at) && at <= now ? [{ key, at }] : [];
	});
	const since =
		observations.length > 0
			? Math.max(...observations.map(({ at }) => at))
			: null;
	const blockers: IdleBlocker[] = observations
		.filter(({ at }) => now - at < idleMinutes * 60_000)
		.map(({ key }) => key);
	if (since === null) blockers.push("activity-unknown");
	if (schedule.mode === "window") {
		const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
		const [startHour, startMinute] = schedule.start.split(":").map(Number);
		const [endHour, endMinute] = schedule.end.split(":").map(Number);
		const start = (startHour ?? 0) * 60 + (startMinute ?? 0);
		const end = (endHour ?? 0) * 60 + (endMinute ?? 0);
		const inside =
			start < end
				? minute >= start && minute < end
				: start > end && (minute >= start || minute < end);
		if (!inside) blockers.push("schedule");
	}
	return { idle: blockers.length === 0, since, blockers };
}
