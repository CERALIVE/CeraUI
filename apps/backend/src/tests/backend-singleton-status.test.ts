import { expect, test } from "bun:test";
import { parseSingletonUids } from "../helpers/backend-singleton-credentials.ts";

const receipt = await Bun.file(
	new URL("./fixtures/real-device/linux-singleton-status.txt", import.meta.url),
).text();
const status = receipt.split("##### status\n")[1] ?? "";

test("credentials parse when the kernel supplies the captured tab-separated status", () => {
	// Given selected byte-exact Linux kernel status rows.
	// When the production parser reads them, then all four kernel credentials survive.
	expect(parseSingletonUids(status)).toEqual([1000, 1000, 1000, 1000]);
});

test.each([
	"",
	"Gid:\t0\t0\t0\t0\n",
	"Uid:\t0\t0\t0\n",
	"Uid:\t0\t0\t0\t0\nUid:\t0\t0\t0\t0\n",
	"Uid:\t-1\t0\t0\t0\n",
	"Uid:\t0\t0\t0\t4294967296\n",
	"Uid:\t0\t0\t0\t0 garbage\n",
])(
	"credentials fail unproven when kernel status is malformed (%j)",
	(input) => {
		// Given absent, duplicate or malformed credentials.
		// When parsing, then no invented uid can qualify the process.
		expect(() => parseSingletonUids(input)).toThrow(
			expect.objectContaining({
				name: "BackendSingletonError",
				reason: "unproven",
			}),
		);
	},
);
