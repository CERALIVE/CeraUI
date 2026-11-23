import { m } from "@ceraui/i18n/svelte";

export function bitrateDisplay(kbps: number | null | undefined) {
	if (kbps == null) return null;
	const unit = kbps >= 1000 ? "Mb" : "kb";
	const value = unit === "Mb" ? kbps / 1000 : kbps;
	const number = Number.isInteger(value) ? String(value) : value.toFixed(1);
	return {
		number,
		unit,
		label: `${number} ${unit === "Mb" ? m["units.mbps"]() : m["units.kbps"]()}`,
	};
}

export function formatBitrate(kbps: number | null | undefined): string {
	return bitrateDisplay(kbps)?.label ?? "—";
}
