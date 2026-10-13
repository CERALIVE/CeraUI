import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDetachedAptServiceFragment } from "../modules/system/software-update-service-contract.ts";
import { readBoardIdentity } from "../modules/system/update-orchestrator/os-identity.ts";
import {
	buildIdFromOsRelease,
	parseRaucSlotBootnames,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";

test.each(["ceralive-rock-5b-plus", "ceralive-orangepi5-plus", ""])(
	"duplicate system sections refuse even when second compatible is %s",
	async (second) => {
		// Given duplicate authority sections, including identical and empty-second forms.
		const root = await mkdtemp(join(tmpdir(), "text-authority-"));
		const path = join(root, "system.conf");
		const bytes = `[system]\ncompatible=ceralive-rock-5b-plus\n[system]\n${second ? `compatible=${second}\n` : ""}`;
		try {
			await writeFile(path, bytes);
			// When board identity is read, then neither section is selected and bytes remain intact.
			await expect(readBoardIdentity(path)).rejects.toMatchObject({
				reason: "rauc_compatible_unknown",
			});
			expect(await readFile(path, "utf8")).toBe(bytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test.each(["release-1", "release-2", ""])(
	"duplicate BUILD_ID refuses second value %s instead of choosing first/fallback",
	(second) => {
		// Given duplicated identity keys, when interpreted, then no build identity is invented.
		expect(() =>
			buildIdFromOsRelease(
				`BUILD_ID="release-1"\nBUILD_ID="${second}"\n`,
				"fallback",
			),
		).toThrow();
	},
);

test.each(["", "bootname=A\n"])(
	"duplicate rootfs section refuses even when second body is %s",
	(body) => {
		// Given a repeated authority section, when parsed, then its first map cannot grant slot identity.
		expect(() =>
			parseRaucSlotBootnames(
				`[slot.rootfs.0]\nbootname=A\n[slot.rootfs.0]\n${body}`,
			),
		).toThrow();
	},
);

test.each(["bootname=\nbootname=A", "bootname=A\nbootname="])(
	"empty bootname cannot hide duplicate identity",
	(body) => {
		// Given ambiguous rootfs keys, when parsed, then an empty line cannot hide its sibling.
		expect(() =>
			parseRaucSlotBootnames(`[slot.rootfs.0]\n${body}\n`),
		).toThrow();
	},
);

test("empty bootname alone is not positive slot identity", () => {
	// Given an empty identity assignment, when parsed, then no empty-name slot mapping is accepted.
	expect(() =>
		parseRaucSlotBootnames("[slot.rootfs.0]\nbootname=\n"),
	).toThrow();
});

test("malformed duplicate compatible cannot hide behind the first valid key", async () => {
	// Given one valid and one syntactically invalid authority key in the same section.
	const root = await mkdtemp(join(tmpdir(), "compatible-duplicate-"));
	const path = join(root, "system.conf");
	try {
		await writeFile(
			path,
			'[system]\ncompatible=ceralive-rock-5b-plus\ncompatible="invalid spaces"\n',
		);
		// When read, then malformed duplicate content cannot select the first board.
		await expect(readBoardIdentity(path)).rejects.toMatchObject({
			reason: "rauc_compatible_unknown",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repeated Service section cannot authorize output cleanup through a first match", () => {
	// Given unique destination keys but two authority sections, when validated, then the fragment refuses.
	expect(() =>
		validateDetachedAptServiceFragment(
			"[Service]\nStandardOutput=append:/run/ceralive/software-update.stdout\nStandardError=append:/run/ceralive/software-update.stderr\n[Service]\n",
		),
	).toThrow();
});
