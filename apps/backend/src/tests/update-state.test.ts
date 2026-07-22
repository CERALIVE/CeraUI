import { describe, expect, it } from "bun:test";

import {
	deriveUpdateIdentity,
	deriveUpdateState,
	type UpdateSnapshot,
	updateDismissalKey,
} from "../modules/system/update-state.ts";

const IDENTITY = deriveUpdateIdentity(["cerastream", "ceraui"], 2, "12.3 MB");

function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
	return {
		checking: false,
		available: false,
		updating: null,
		failure: null,
		succeeded: false,
		...overrides,
	};
}

describe("deriveUpdateIdentity", () => {
	it("sorts the package set so ordering never changes the identity", () => {
		const a = deriveUpdateIdentity(["ceraui", "cerastream"], 2, "12.3 MB");
		const b = deriveUpdateIdentity(["cerastream", "ceraui"], 2, "12.3 MB");
		expect(a.packages).toEqual(["cerastream", "ceraui"]);
		expect(a.version).toBe(b.version);
	});

	it("changes the version when the package set changes (new update re-notifies)", () => {
		const a = deriveUpdateIdentity(["cerastream"], 1, "5 MB");
		const b = deriveUpdateIdentity(["cerastream", "srtla"], 2, "9 MB");
		expect(a.version).not.toBe(b.version);
	});

	it("changes the version when the download size changes (same-name version bump)", () => {
		const a = deriveUpdateIdentity(["cerastream"], 1, "5 MB");
		const b = deriveUpdateIdentity(["cerastream"], 1, "6 MB");
		expect(a.version).not.toBe(b.version);
	});
});

describe("updateDismissalKey", () => {
	it("is namespaced by version so a new version key differs", () => {
		expect(updateDismissalKey(IDENTITY)).toBe(`update:${IDENTITY.version}`);
	});
});

describe("deriveUpdateState", () => {
	it("is idle when nothing is happening", () => {
		expect(deriveUpdateState(snapshot())).toEqual({ kind: "idle" });
	});

	it("is checking while apt discovery runs", () => {
		expect(deriveUpdateState(snapshot({ checking: true }))).toEqual({
			kind: "checking",
		});
	});

	it("is available (with identity) when apt found packages — the dialog needs no re-check", () => {
		const state = deriveUpdateState(
			snapshot({
				available: {
					identity: IDENTITY,
					package_count: 2,
					download_size: "12.3 MB",
				},
			}),
		);
		expect(state).toEqual({
			kind: "available",
			identity: IDENTITY,
			package_count: 2,
			download_size: "12.3 MB",
		});
	});

	it("is downloading while apt is fetching (no unpack/install yet)", () => {
		const state = deriveUpdateState(
			snapshot({
				updating: { total: 2, downloading: 1, unpacking: 0, setting_up: 0 },
				available: {
					identity: IDENTITY,
					package_count: 2,
					download_size: "12.3 MB",
				},
			}),
		);
		expect(state.kind).toBe("downloading");
	});

	it("is installing once unpack/setup starts", () => {
		const state = deriveUpdateState(
			snapshot({
				updating: { total: 2, downloading: 2, unpacking: 1, setting_up: 0 },
			}),
		);
		expect(state.kind).toBe("installing");
	});

	it("is failed(reason) after a failed apt run, and failure outranks a still-available update", () => {
		const state = deriveUpdateState(
			snapshot({
				failure: { reason: "dpkg was interrupted", identity: IDENTITY },
				available: {
					identity: IDENTITY,
					package_count: 2,
					download_size: "12.3 MB",
				},
			}),
		);
		expect(state).toEqual({
			kind: "failed",
			reason: "dpkg was interrupted",
			identity: IDENTITY,
		});
	});

	it("keeps failed visible while a background check runs (failure outranks checking)", () => {
		const state = deriveUpdateState(
			snapshot({
				checking: true,
				failure: { reason: "network down" },
			}),
		);
		expect(state).toEqual({ kind: "failed", reason: "network down" });
	});

	it("is success after a clean install", () => {
		expect(deriveUpdateState(snapshot({ succeeded: true }))).toEqual({
			kind: "success",
		});
	});

	it("prioritizes an in-flight install over a stale terminal flag", () => {
		const state = deriveUpdateState(
			snapshot({
				succeeded: true,
				updating: { total: 2, downloading: 2, unpacking: 1, setting_up: 0 },
			}),
		);
		expect(state.kind).toBe("installing");
	});

	it("treats apt-disabled (available === false) as idle, not available", () => {
		expect(deriveUpdateState(snapshot({ available: false }))).toEqual({
			kind: "idle",
		});
	});
});
