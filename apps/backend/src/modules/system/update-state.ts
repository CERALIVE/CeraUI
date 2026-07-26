import { createHash } from "node:crypto";

import type {
	UpdateCheckFailureReason,
	UpdateIdentity,
	UpdateProgress,
	UpdateState,
} from "@ceraui/rpc/schemas";

export type {
	UpdateCheckFailureReason,
	UpdateIdentity,
	UpdateState,
} from "@ceraui/rpc/schemas";

export interface AvailableUpdate {
	identity: UpdateIdentity;
	package_count: number;
	download_size?: string;
}

export interface UpdateFailure {
	reason: string;
	identity?: UpdateIdentity;
}

// The raw backend signals the reducer folds into ONE state. `available === false`
// means apt-update is disabled; `null` means enabled-but-not-yet-discovered.
export interface UpdateSnapshot {
	checking: boolean;
	available: AvailableUpdate | null | false;
	updating: UpdateProgress | null;
	failure: UpdateFailure | null;
	succeeded: boolean;
	checkFailure?: UpdateCheckFailureReason | null;
	checkedAt?: number | null;
}

// The version signature covers the sorted package set + count + download size, so
// a same-name version bump (which changes the .deb size) still yields a new key —
// the dismissal store then re-notifies for it (Todo-23 semantic-identity keying).
export function deriveUpdateIdentity(
	packages: string[],
	packageCount: number,
	downloadSize?: string,
): UpdateIdentity {
	const sorted = [...packages].sort();
	const signature = createHash("sha256")
		.update(`${sorted.join(" ")}|${packageCount}|${downloadSize ?? ""}`)
		.digest("hex")
		.slice(0, 12);
	return { version: signature, packages: sorted };
}

export function updateDismissalKey(identity: UpdateIdentity): string {
	return `update:${identity.version}`;
}

function deriveInstallState(progress: UpdateProgress): UpdateState {
	const installing = progress.unpacking > 0 || progress.setting_up > 0;
	return installing
		? { kind: "installing", progress }
		: { kind: "downloading", progress };
}

// Precedence: an in-flight install outranks everything, then a terminal
// failure/success, then an available update, then a bare in-progress check, then
// a failed check. Failure deliberately outranks `checking` so a background
// re-check never masks a real failed-update state. A failed CHECK sits BELOW
// `available` on purpose — a known-available update stays installable even when a
// later refresh could not reach the repos — but ABOVE `idle`, because "we could
// not check" must never render as "up to date".
export function deriveUpdateState(s: UpdateSnapshot): UpdateState {
	if (s.updating) return deriveInstallState(s.updating);
	if (s.failure) {
		return s.failure.identity
			? {
					kind: "failed",
					reason: s.failure.reason,
					identity: s.failure.identity,
				}
			: { kind: "failed", reason: s.failure.reason };
	}
	if (s.succeeded) return { kind: "success" };

	const checkedAt = s.checkedAt ?? undefined;
	const stamp = checkedAt !== undefined ? { checked_at: checkedAt } : {};

	if (s.available && s.available.package_count > 0) {
		const { identity, package_count, download_size } = s.available;
		return download_size !== undefined
			? { kind: "available", identity, package_count, download_size, ...stamp }
			: { kind: "available", identity, package_count, ...stamp };
	}
	if (s.checking) return { kind: "checking", ...stamp };
	if (s.checkFailure) {
		return { kind: "check_failed", reason: s.checkFailure, ...stamp };
	}
	return { kind: "idle", ...stamp };
}
