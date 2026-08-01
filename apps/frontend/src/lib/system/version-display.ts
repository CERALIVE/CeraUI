/**
 * One presentation rule for every row of Settings → Versions.
 *
 * The rows come from four unrelated producers — a git hash, `Bun.version`,
 * `uname -r`, the engine's IPC `hello`, and `srtla_send -v` — and only the last
 * one carries build metadata. It used to render its whole CLI line verbatim
 * (`3.2.0 (main@974c8b9) [srtla_send]`) beside three bare version numbers, so
 * one row read as noise next to its neighbours.
 *
 * Splitting the line here means every row renders the SAME shape: a version as
 * the primary value, with any build metadata demoted to a secondary line. The
 * package tag is dropped outright — the row's own label already names the
 * component.
 */
export interface VersionDisplay {
	/** The version number, rendered as the row's primary value. */
	value: string;
	/** Build metadata (e.g. `main@974c8b9`), rendered as a secondary line. */
	detail?: string;
}

/** `(...)` build metadata followed by an optional `[package]` tag, at end of line. */
const BUILD_METADATA_RE = /^(.*?)\s*\(([^()]*)\)\s*(?:\[[^\]]*\])?$/;
/** A bare `[package]` tag at end of line, with no build metadata before it. */
const PACKAGE_TAG_RE = /^(.*?)\s*\[[^\]]*\]$/;

export function splitVersionValue(raw: string): VersionDisplay {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { value: raw };

	const withMetadata = BUILD_METADATA_RE.exec(trimmed);
	if (withMetadata) {
		const value = (withMetadata[1] ?? "").trim();
		const detail = (withMetadata[2] ?? "").trim();
		// A line that is ONLY a parenthetical has no version to promote, so it is
		// left whole rather than emptied out.
		if (value.length > 0) {
			return detail.length > 0 ? { value, detail } : { value };
		}
		return { value: trimmed };
	}

	const withTag = PACKAGE_TAG_RE.exec(trimmed);
	if (withTag) {
		const value = (withTag[1] ?? "").trim();
		if (value.length > 0) return { value };
	}

	return { value: trimmed };
}
