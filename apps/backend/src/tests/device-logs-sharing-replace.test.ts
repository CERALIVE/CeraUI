import { expect, spyOn, test } from "bun:test";
import type { LogExportOutput } from "@ceraui/rpc/schemas";
import {
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";

const downloads = {
	export: {
		create: (conn: object) => createExport(conn, { filter: {} }),
		get: handleLogExportRequest,
	},
	bundle: { create: createBundle, get: handleLogBundleRequest },
} as const;

function issued(
	result: LogExportOutput,
): Extract<LogExportOutput, { ok: true }> {
	if (!result.ok)
		throw new Error(`Expected a ticket, received ${result.error}`);
	return result;
}

function get(kind: keyof typeof downloads, url: string) {
	return downloads[kind].get(new Request(`http://device${url}`));
}

test.each([
	["export", "export"],
	["bundle", "bundle"],
	["export", "bundle"],
	["bundle", "export"],
] as const)(
	"the same connection replaces an unused %s with %s",
	async (first, next) => {
		const fixture = historyFixture(false);
		const conn = {};
		try {
			const previous = issued(await downloads[first].create(conn));

			const replacement = await downloads[next].create(conn);

			expect(replacement).toMatchObject({ ok: true });
			const current = issued(replacement);
			expect(current.url).not.toBe(previous.url);
			expect((await get(first, previous.url)).status).toBe(403);
			const response = await get(next, current.url);
			try {
				expect(response.status).toBe(200);
			} finally {
				await response.body?.cancel();
			}
		} finally {
			await fixture.dispose();
		}
	},
);

test("a foreign connection is Busy until the original ticket's sixty seconds expire", async () => {
	const fixture = historyFixture(false);
	const start = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(start);
	try {
		const original = issued(await createBundle({}));
		const foreign = {};
		clock.mockReturnValue(start + 59_999);
		expect(await downloads.export.create(foreign)).toEqual({
			ok: false,
			error: "BUSY",
		});

		clock.mockReturnValue(start + 60_000);
		expect(await downloads.export.create(foreign)).toMatchObject({ ok: true });
		expect((await get("bundle", original.url)).status).toBe(403);
	} finally {
		clock.mockRestore();
		await fixture.dispose();
	}
});

test("a bundle preview cannot replace a pending export ticket", async () => {
	const fixture = historyFixture(false);
	try {
		const original = issued(await downloads.export.create({}));

		await expect(previewBundle()).rejects.toMatchObject({ code: "BUSY" });

		const response = await get("export", original.url);
		try {
			expect(response.status).toBe(200);
		} finally {
			await response.body?.cancel();
		}
	} finally {
		await fixture.dispose();
	}
});

test("a second request from the same connection is Busy while a bundle is preparing", async () => {
	const fixture = historyFixture(false);
	const conn = {};
	const gate = fixture.ownedLatch();
	const context = await fixture.context();
	fixture.context.mockImplementationOnce(async () => {
		await gate.hold();
		return context;
	});
	try {
		const preparing = fixture.own(createBundle(conn));
		await bounded(gate.entered);

		expect(await downloads.export.create(conn)).toEqual({
			ok: false,
			error: "BUSY",
		});

		gate.release();
		expect(await bounded(preparing)).toMatchObject({ ok: true });
	} finally {
		await fixture.dispose();
	}
});

test.each(["export", "bundle"] as const)(
	"a second request from the same connection is Busy while %s streams",
	async (kind) => {
		const fixture = historyFixture(false);
		const conn = {};
		try {
			const original = issued(await downloads[kind].create(conn));
			const response = await get(kind, original.url);
			try {
				expect(response.status).toBe(200);
				expect(await downloads.export.create(conn)).toEqual({
					ok: false,
					error: "BUSY",
				});
			} finally {
				await response.body?.cancel();
			}
			expect(await downloads.export.create(conn)).toMatchObject({ ok: true });
		} finally {
			await fixture.dispose();
		}
	},
);
