export const bootId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export function journalObject(fields: Record<string, unknown> = {}) {
	return {
		__CURSOR: "s=1",
		__REALTIME_TIMESTAMP: "1700000000000000",
		_BOOT_ID: bootId,
		MESSAGE: "hello",
		...fields,
	};
}
export const journalLine = (fields: Record<string, unknown> = {}) =>
	`${JSON.stringify(journalObject(fields))}\n`;
