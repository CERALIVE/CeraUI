import {
	deviceEventSchema,
	eventBootRecordSchema,
	logBundleManifestSchema,
	logEntrySchema,
	logErrorCodeSchema,
	logRetentionSchema,
	versionContextSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";

const exporterRow = z.strictObject({
	section: z.literal("versions"),
	exportedBy: versionContextSchema,
});
const bootRow = logBundleManifestSchema.shape.boots.element.extend({
	section: z.literal("versions"),
});
const timestamp = logEntrySchema.shape.ts;
const settingsRow = z.strictObject({
	section: z.literal("settings"),
	logs: logRetentionSchema,
	state: z.strictObject({
		historyEpoch: timestamp,
		lastClearedAt: timestamp.nullable(),
		lastMaintenance: z
			.strictObject({
				at: timestamp,
				ok: z.boolean(),
				targetMet: z.boolean(),
			})
			.nullable(),
	}),
	updateChannel: z.string(),
	autostart: z.boolean().nullable(),
	hardwareKind: z.string(),
	data: z.strictObject({ used: z.number(), total: z.number() }).nullable(),
});
const eventRow = z.strictObject({
	section: z.literal("events"),
	event: deviceEventSchema.strict(),
});
const eventBootRow = z.strictObject({
	section: z.literal("events"),
	boot: eventBootRecordSchema,
});
const journalRow = z.strictObject({
	section: z.literal("journal"),
	entry: logEntrySchema,
});
const cutRow = z.strictObject({
	section: z.literal("journal"),
	incomplete: z.union([
		logErrorCodeSchema,
		z.enum(["time_limit", "size_limit", "compressed_size_limit"]),
	]),
});
const endRow = z.strictObject({
	section: z.literal("end"),
	complete: z.boolean(),
});

export function journalBootIds(records: readonly Record<string, unknown>[]) {
	const [first, current, previousOrSettings, afterPrevious] = records;
	const exporter = exporterRow.safeParse(first);
	const running = bootRow.safeParse(current);
	const hasPrevious = previousOrSettings?.section === "versions";
	if (
		!exporter.success ||
		!running.success ||
		running.data.bootId !== exporter.data.exportedBy.bootId ||
		!settingsRow.safeParse(hasPrevious ? afterPrevious : previousOrSettings)
			.success ||
		records
			.slice(hasPrevious ? 3 : 2)
			.some((record) => record.section === "versions") ||
		(running.data.versions &&
			running.data.versions.bootId !== running.data.bootId)
	)
		return [];
	if (!hasPrevious) return [running.data.bootId];
	const previous = bootRow.safeParse(previousOrSettings);
	if (
		!previous.success ||
		previous.data.bootId === running.data.bootId ||
		(previous.data.versions &&
			previous.data.versions.bootId !== previous.data.bootId)
	)
		return [];
	return [running.data.bootId, previous.data.bootId];
}

// Production emits versions, settings, events, event boots, previous/current
// journal entries, an optional cut and one end. Never move backwards.
export function classifyBundleRecords(
	records: readonly Record<string, unknown>[],
	[running, previous]: readonly string[],
) {
	let phase = -1;
	let cutSeen = false;
	let settingsSeen = false;
	return records.map((record, index) => {
		let valid = false;
		let order = phase;
		let scannedBoot: string | undefined;
		switch (record.section) {
			case "versions":
				order = 0;
				valid =
					index === 0
						? exporterRow.safeParse(record).success
						: index <= 2 && bootRow.safeParse(record).success;
				break;
			case "settings":
				order = 1;
				valid = !settingsSeen && settingsRow.safeParse(record).success;
				settingsSeen ||= valid;
				break;
			case "events":
				order = "boot" in record ? 3 : 2;
				valid =
					settingsSeen &&
					(order === 3 ? eventBootRow : eventRow).safeParse(record).success;
				break;
			case "journal": {
				if ("incomplete" in record) {
					order = 6;
					valid = !cutSeen && cutRow.safeParse(record).success;
					cutSeen = true;
					break;
				}
				const entry = journalRow.safeParse(record);
				const boot = entry.success ? entry.data.entry.bootId : undefined;
				order = boot !== undefined && boot === previous ? 4 : 5;
				valid =
					settingsSeen &&
					!cutSeen &&
					entry.success &&
					boot !== undefined &&
					(boot === running || boot === previous);
				if (valid && order >= phase) scannedBoot = boot;
				break;
			}
			case "end":
				order = 7;
				valid =
					endRow.safeParse(record).success &&
					record.complete === !cutSeen &&
					(cutSeen || running !== undefined);
				break;
		}
		const invalid = !valid || order < phase;
		phase = Math.max(phase, order);
		return { invalid, scannedBoot };
	});
}
