/*
 * Task 13 — srtla.ts Bun-native I/O migration.
 *
 * Proves the two semantics that MUST NOT drift after replacing node:fs sync
 * APIs with Bun-native equivalents:
 *
 *   1. srtla ips-file write (fs.writeFileSync -> Bun.write) is BYTE-IDENTICAL
 *      to the pre-migration output. The srtla_send sender parses this file;
 *      any format drift (extra newline, encoding change) breaks link
 *      aggregation. We compare the migrated writer's bytes against a reference
 *      produced by the original node:fs.writeFileSync.
 *
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../modules/setup.ts";
import { setSrtlaIpList } from "../modules/streaming/srtla.ts";

const ipsFile = setup.ips_file ?? "/tmp/srtla_ips";

describe("srtla ips-file writer (Task 13 Bun.write migration)", () => {
	it("writes byte-identical content vs pre-migration fs.writeFileSync", async () => {
		const addresses = ["192.168.1.1", "192.168.1.2", "10.0.0.5"];
		const list = addresses.join("\n");

		const dir = mkdtempSync(join(tmpdir(), "srtla-ips-"));
		const refPath = join(dir, "ref_ips");
		writeFileSync(refPath, list);
		const refBytes = new Uint8Array(await Bun.file(refPath).arrayBuffer());

		await setSrtlaIpList(addresses);
		const outBytes = new Uint8Array(await Bun.file(ipsFile).arrayBuffer());

		expect(outBytes).toEqual(refBytes);
		expect(new TextDecoder().decode(outBytes)).toBe(
			"192.168.1.1\n192.168.1.2\n10.0.0.5",
		);
	});

	it("preserves exact format: newline-joined, no trailing newline", async () => {
		await setSrtlaIpList(["1.2.3.4"]);
		expect(await Bun.file(ipsFile).text()).toBe("1.2.3.4");

		await setSrtlaIpList(["1.1.1.1", "2.2.2.2"]);
		expect(await Bun.file(ipsFile).text()).toBe("1.1.1.1\n2.2.2.2");
	});

	it("writes an empty file for an empty address list", async () => {
		await setSrtlaIpList([]);
		expect(await Bun.file(ipsFile).text()).toBe("");
	});
});
