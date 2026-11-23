import { expect, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import { readNmProfileInstance } from "../modules/network/network-manager-profile-instance.ts";
import { firstAp, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

test("filename receipt uses the supported connection-list FILENAME field", async () => {
	const f = await firstAp();
	try {
		const filename = f.nm.files.filename(OTHER_UUID);
		const receipt = await readNmProfileInstance(OTHER_UUID);
		expect(receipt?.file?.filename).toBe(filename);
	} finally {
		await f.restore();
	}
});

test("fake NM rejects GENERAL.FILENAME details with NM 1.42's exit and stderr", async () => {
	const f = await firstAp();
	try {
		await expect(
			exec.execFileP("nmcli", [
				"--terse",
				"--get-values",
				"GENERAL.FILENAME",
				"connection",
				"show",
				OTHER_UUID,
			]),
		).rejects.toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: 'connection show': invalid field 'GENERAL.FILENAME'",
		});
	} finally {
		await f.restore();
	}
});
