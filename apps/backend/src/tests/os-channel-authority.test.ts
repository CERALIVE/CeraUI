import { describe, expect, test } from "bun:test";
import { resolveOsChannel } from "../modules/system/update-orchestrator/os-manifest.ts";

const valid = { content: "drill", uid: 0, mode: 0o644, regular: true };

describe("OS channel authority", () => {
	for (const settings of ["stable", "beta"] as const) {
		test(`uses ${settings} only when the override is absent`, async () => {
			// Given authoritative absence, when resolving, then settings may select.
			expect(
				await resolveOsChannel(settings, {
					readOverride: async () => undefined,
					warn: () => undefined,
				}),
			).toBe(settings);
		});
		test(`preserves drill instead of ${settings} when authority is valid`, async () => {
			// Given a distinct override, when resolving, then it alone selects.
			expect(
				await resolveOsChannel(settings, {
					readOverride: async () => valid,
					warn: () => undefined,
				}),
			).toBe("drill");
		});
		for (const code of ["EIO", "EACCES", "oversize", "invalid_utf8"] as const) {
			test(`refuses ${settings} fallback when the override read fails with ${code}`, async () => {
				// Given unreadable authority, when resolving, then no channel is granted.
				await expect(
					resolveOsChannel(settings, {
						readOverride: async () => {
							throw Object.assign(new Error(code), { code });
						},
						warn: () => undefined,
					}),
				).rejects.toMatchObject({ reason: "discovery_failed" });
			});
		}
		for (const override of [
			{ ...valid, content: "drill\n" },
			{ ...valid, content: '{"channel":"drill","channel":"stable"}' },
			{ ...valid, content: "" },
			{ ...valid, uid: 1000 },
			{ ...valid, mode: 0o666 },
			{ ...valid, regular: false },
		]) {
			test(`refuses invalid override ${JSON.stringify(override)} instead of ${settings}`, async () => {
				// Given present invalid bytes/metadata, when resolving, then refuse.
				await expect(
					resolveOsChannel(settings, {
						readOverride: async () => override,
						warn: () => undefined,
					}),
				).rejects.toMatchObject({ reason: "discovery_failed" });
			});
		}
	}
	test("recovers on a later valid read without caching the fallback", async () => {
		// Given one refused read followed by repaired authority.
		let repaired = false;
		const io = {
			readOverride: async () => {
				if (!repaired) throw Object.assign(new Error("EIO"), { code: "EIO" });
				return valid;
			},
			warn: () => undefined,
		};
		await expect(resolveOsChannel("stable", io)).rejects.toMatchObject({
			reason: "discovery_failed",
		});
		repaired = true;
		// When reading repaired authority, then drill is selected afresh.
		expect(await resolveOsChannel("stable", io)).toBe("drill");
	});
});
