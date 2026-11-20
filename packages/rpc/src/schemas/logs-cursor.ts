export const LOG_FOLLOW_BOOT_START_PREFIX = 'boot-start:';

export function journalCursorBoot(cursor: string): string | undefined {
	return /(?:^|;)b=([0-9a-f]{32})(?:;|$)/.exec(cursor)?.[1];
}

export function followCheckpointBoot(cursor: string | null): string | undefined {
	if (cursor === null) return undefined;
	if (cursor.startsWith(LOG_FOLLOW_BOOT_START_PREFIX))
		return /^([0-9a-f]{32}):[0-9]+(?::[0-9a-f-]+:[0-9]+)?$/.exec(
			cursor.slice(LOG_FOLLOW_BOOT_START_PREFIX.length),
		)?.[1];
	return journalCursorBoot(cursor);
}
