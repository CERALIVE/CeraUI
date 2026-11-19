import { expect, test } from "bun:test";
import { startFollow, stopFollow } from "../modules/device-logs/follow.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { followFixture, record } from "./helpers/device-follow.ts";

test("a catch-up gap can page from its old checkpoint through its restart head", async () => {
	const f = followFixture();
	const connector = {};
	try {
		f.rows.push(record(2));
		const start = await startFollow(
			f.conn,
			{ afterCursor: "s=1", text: "entry" },
			f.options,
		);
		expect(start.ok).toBe(true);
		const child = f.children[0];
		if (!child) throw new Error("missing follower");
		f.rows.push(...Array.from({ length: 2001 }, (_, i) => record(i + 3)));
		await child.emit(f.rows.slice(0, -1));
		await f.sent;
		const gap = f.messages[0];
		expect(gap?.gap).toBe("catchup_exceeded");
		const from = gap?.gapFrom;
		expect(typeof from).toBe("string");
		if (typeof from !== "string") throw new Error("missing gap position");
		const input = { text: "entry", direction: "newer", limit: 2 } as const;
		const page = await queryLogs(connector, { ...input, continuation: from });
		expect(page).toMatchObject({
			ok: true,
			entries: [{ cursor: "s=2" }, { cursor: "s=3" }],
			hasMore: true,
		});
		expect(
			await queryLogs(connector, {
				...input,
				text: "other",
				continuation: from,
			}),
		).toEqual({ ok: false, error: "FILTER_CHANGED" });

		f.rows.push(record(2004, { MESSAGE: "entry outside the gap" }));
		let tail = page;
		for (
			let remaining = 12;
			remaining > 0 && tail.ok && tail.continuation !== null;
			remaining--
		)
			tail = await queryLogs(connector, {
				...input,
				limit: 200,
				continuation: tail.continuation,
			});
		expect(tail.ok && tail.entries.at(-1)?.cursor).toBe("s=2003");
		expect(tail.ok && tail.continuation).toBeNull();
	} finally {
		await stopFollow(f.conn);
		f.restore();
	}
});
