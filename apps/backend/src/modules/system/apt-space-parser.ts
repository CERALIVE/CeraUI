import { isAbsolute } from "node:path";
import type { UpdatePreflightReason } from "@ceraui/rpc";
import { z } from "zod";

export class AptPreflightError extends Error {
	override readonly name = "AptPreflightError";
	constructor(
		readonly reason: UpdatePreflightReason,
		options?: ErrorOptions,
	) {
		super(`Software update preflight failed: ${reason}`, options);
	}
}

const byteSchema = z
	.bigint()
	.min(0n)
	.max(BigInt(Number.MAX_SAFE_INTEGER))
	.brand("AptBytes");
export type AptBytes = z.infer<typeof byteSchema>;

export function aptBytes(value: bigint): AptBytes {
	const parsed = byteSchema.safeParse(value);
	if (!parsed.success) throw new AptPreflightError("value_out_of_range");
	return parsed.data;
}

export function parseAptArchivePath(output: string): string {
	// apt-config emits shell QUOTING, not executable input. Decode only its assignment.
	const match = /^ARCHIVES='((?:[^']|'\\'')*)';?$/.exec(output.trim());
	const path = match?.[1]?.replaceAll("'\\''", "'");
	if (!path || !isAbsolute(path) || /\p{Cc}/u.test(path))
		throw new AptPreflightError("archive_path_invalid");
	return path;
}

export type AptSpaceEstimate = {
	readonly download_bytes: AptBytes;
	readonly install_delta_bytes: AptBytes;
};

export function parseAptSpaceProbe(output: string): AptSpaceEstimate {
	const lines = output.split(/\r?\n/).map((line) => line.trim());
	const rows = lines.filter((line) => line.startsWith("'"));
	if (rows.length === 0) throw new AptPreflightError("probe_no_uri_rows");
	let download = 0n;
	for (const row of rows) {
		const size = /^'[^']+'\s+\S+\s+(-?\d+)(?:\s+\S+)?$/.exec(row)?.[1];
		if (size === undefined)
			throw new AptPreflightError("probe_uri_size_malformed");
		download = aptBytes(download + aptBytes(BigInt(size)));
	}

	const deltas = lines.filter((line) =>
		line.startsWith("After this operation,"),
	);
	const delta =
		/^After this operation, (-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?) (B|kB|MB|GB|TB|PB|EB) (of additional disk space will be used|disk space will be freed)\.$/.exec(
			deltas[0] ?? "",
		);
	const amount = delta?.[1];
	const unit = delta?.[2];
	if (deltas.length !== 1 || amount === undefined || unit === undefined) {
		throw new AptPreflightError("probe_delta_malformed");
	}
	const [whole = "", fraction = ""] = amount.replaceAll(",", "").split(".");
	if (amount.startsWith("-") || amount.length > 64)
		throw new AptPreflightError("value_out_of_range");
	const power = ["B", "kB", "MB", "GB", "TB", "PB", "EB"].indexOf(unit);
	const denominator = 10n ** BigInt(fraction.length);
	const numerator = BigInt(whole + fraction) * 1000n ** BigInt(power);
	// Round up at the byte boundary: a fractional byte must never undercount admission.
	const bytes = aptBytes((numerator + denominator - 1n) / denominator);
	return {
		download_bytes: aptBytes(download),
		install_delta_bytes:
			delta?.[3] === "disk space will be freed" ? aptBytes(0n) : bytes,
	};
}
