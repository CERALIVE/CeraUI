/*
 * Task 13 — srtla.ts Bun-native I/O migration, re-pinned against the ADR-003
 * writer.
 *
 * The ips-file bytes are a PARITY CONTRACT: `srtla_send` parses this file, and
 * ADR-003 keeps it BYTE-UNCHANGED so every already-deployed sender and every
 * hand-run invocation still reads it. So the same assertions that pinned the
 * fs.writeFileSync → Bun.write migration now pin the two-file publisher: adding
 * a sidecar must not have moved a single byte of the file beside it.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../modules/setup.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import { publishSrtlaBond } from "../modules/streaming/srtla.ts";

const ipsFile = setup.ips_file ?? "/tmp/srtla_ips";

const entries = (...ips: string[]): BondEntry[] =>
	ips.map((ip, index) => ({
		ip,
		iface: `eth${index}`,
		linkId: `lnk_eth${index}`,
	}));

describe("srtla ips-file writer (Task 13 Bun.write migration)", () => {
	it("writes byte-identical content vs pre-migration fs.writeFileSync", async () => {
		const addresses = ["192.168.1.1", "192.168.1.2", "10.0.0.5"];
		const list = addresses.join("\n");

		const dir = mkdtempSync(join(tmpdir(), "srtla-ips-"));
		const refPath = join(dir, "ref_ips");
		writeFileSync(refPath, list);
		const refBytes = new Uint8Array(await Bun.file(refPath).arrayBuffer());

		await publishSrtlaBond(entries(...addresses));
		const outBytes = new Uint8Array(await Bun.file(ipsFile).arrayBuffer());

		expect(outBytes).toEqual(refBytes);
		expect(new TextDecoder().decode(outBytes)).toBe(
			"192.168.1.1\n192.168.1.2\n10.0.0.5",
		);
	});

	it("preserves exact format: newline-joined, no trailing newline", async () => {
		await publishSrtlaBond(entries("1.2.3.4"));
		expect(await Bun.file(ipsFile).text()).toBe("1.2.3.4");

		await publishSrtlaBond(entries("1.1.1.1", "2.2.2.2"));
		expect(await Bun.file(ipsFile).text()).toBe("1.1.1.1\n2.2.2.2");
	});

	it("writes an empty file for an empty address list", async () => {
		await publishSrtlaBond([]);
		expect(await Bun.file(ipsFile).text()).toBe("");
	});
});
