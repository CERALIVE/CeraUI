/**
 * Where the System Logs regions go: at >= 1024 px a side column holds Boots,
 * Storage and Downloads; below it Storage becomes a third tab. Downloads never
 * waits for the tabs, so it stays in the main column until they render. On an
 * older backend Downloads sits below the not-available notice, whose copy says so.
 */
import type { LogViewerAvailability } from "./viewer-availability";

export type ShellStatus = "loading" | LogViewerAvailability;
export type ShellTab = "events" | "raw" | "storage";
export type DownloadsPlacement = "side" | "storage" | "main";

const WIDE_TABS: readonly ShellTab[] = ["events", "raw"];
const NARROW_TABS: readonly ShellTab[] = ["events", "raw", "storage"];

export function shellTabs(wide: boolean): readonly ShellTab[] {
	return wide ? WIDE_TABS : NARROW_TABS;
}

export function activeTab(
	selected: string | undefined,
	tabs: readonly ShellTab[],
): ShellTab {
	return tabs.find((tab) => tab === selected) ?? "events";
}

export function downloadsPlacement(
	status: ShellStatus,
	wide: boolean,
): DownloadsPlacement {
	if (status === "unavailable") return "main";
	if (wide) return "side";
	return status === "ready" ? "storage" : "main";
}
