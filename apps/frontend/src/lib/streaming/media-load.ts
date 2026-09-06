import type { EncoderLoadReading } from "./encoder-load";

export type MediaLoadGroup = NonNullable<EncoderLoadReading["blocks"]>[number];

export const MEDIA_GROUP_LABELS = {
	rkvenc: "settings.mediaLoad.encode",
	rkvdec: "settings.mediaLoad.decode",
	jpgdec: "settings.mediaLoad.jpeg",
	rga: "settings.mediaLoad.rga",
} as const satisfies Record<MediaLoadGroup["block"], string>;

export const MEDIA_LOAD_STALE_MS = 6_000;

export function mediaCoreHintLabel(core: string): string {
	const scheduler = /^scheduler\[(\d+)\]: (\S+)$/.exec(core);
	if (scheduler) return `${scheduler[2]}[${scheduler[1]}]`;
	return /^([\da-f]+)\./i.exec(core)?.[1] ?? core;
}

export function isMediaLoadStale(
	reading: EncoderLoadReading,
	now: number,
): boolean {
	return (
		reading.updatedAt === null || now - reading.updatedAt > MEDIA_LOAD_STALE_MS
	);
}

export function mediaLoadCoreCount(groups: readonly MediaLoadGroup[]): number {
	return groups.reduce((count, group) => count + group.cores.length, 0);
}
