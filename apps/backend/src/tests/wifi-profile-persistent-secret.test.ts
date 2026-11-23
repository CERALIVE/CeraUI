import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNmProfileFileSecret } from "../modules/network/network-manager-profile-file.ts";

for (const row of [
	{
		name: "GLib escaped whitespace, backslash and UTF-8",
		bytes: "[wifi-security]\npsk=\\s\\\\persisted-\u00f1\\n\\r\\t\\s\n",
		expected: { password: " \\persisted-\u00f1\n\r\t " },
	},
	{
		name: "last key across repeated groups",
		bytes:
			"[wifi-security]\npsk=old-secret\n[ipv4]\nmethod=shared\n[wifi-security]\npsk=new-secret\n",
		expected: { password: "new-secret" },
	},
	{
		name: "NM long group alias",
		bytes: "[802-11-wireless-security]\npsk=alias-secret\n",
		expected: { password: "alias-secret" },
	},
	{
		name: "literal placeholder is persisted data",
		bytes: "[wifi-security]\npsk=<hidden>\n",
		expected: { password: "<hidden>" },
	},
	{
		name: "missing key remains absent",
		bytes: "[wifi-security]\nkey-mgmt=wpa-psk\n# psk=not-a-secret\n",
		expected: { password: undefined },
	},
	{
		name: "invalid GLib escape fails closed",
		bytes: "[wifi-security]\npsk=invalid\\qescape\n",
		expected: undefined,
	},
	{
		name: "trailing escape fails closed",
		bytes: "[wifi-security]\npsk=invalid\\\n",
		expected: undefined,
	},
] as const) {
	test(`persistent PSK observation: ${row.name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "persistent-wifi-secret-"));
		try {
			const filename = join(root, "profile.nmconnection");
			await writeFile(filename, row.bytes, { mode: 0o600 });
			const info = await stat(filename, { bigint: true });
			expect(
				await readNmProfileFileSecret({
					filename,
					device: String(info.dev),
					inode: String(info.ino),
					ctime: String(info.ctimeNs),
				}),
			).toEqual(row.expected);
			expect(await readFile(filename, "utf8")).toBe(row.bytes);
		} finally {
			await rm(root, { recursive: true });
		}
	});
}
