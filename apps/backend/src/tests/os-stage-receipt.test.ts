import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitStagedManifest,
	saveStagedManifest,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";

const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});
const receipt = {
	schema: 1 as const,
	version: manifest.version,
	channel: manifest.channel,
	bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	stagedAt: 1000,
};
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "os-stage-receipt-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("the final commit publishes receipt and serial synchronously", async () => {
	const committed = commitStagedManifest(manifest, receipt, dir);
	expect(committed).toEqual(receipt);
	expect(await Bun.file(join(dir, "os-staged.json")).json()).toEqual(receipt);
	expect(await Bun.file(join(dir, "manifest-serial.stable")).text()).toBe(
		"3\n",
	);
});

test("serial persistence failure cannot return a committed success", async () => {
	await mkdir(join(dir, "manifest-serial.stable"));
	expect(() => commitStagedManifest(manifest, receipt, dir)).toThrow();
	expect(await Bun.file(join(dir, "os-staged.json")).json()).toEqual(receipt);
});

test("the existing async save wrapper keeps the receipt and serial contract", async () => {
	expect(
		await saveStagedManifest(manifest, receipt.bootId, receipt.stagedAt, dir),
	).toEqual(receipt);
	expect(await Bun.file(join(dir, "manifest-serial.stable")).text()).toBe(
		"3\n",
	);
});
