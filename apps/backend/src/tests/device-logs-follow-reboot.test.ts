import { expect, test } from "bun:test";
import { startFollow, stopFollow } from "../modules/device-logs/follow.ts";
import { followFixture, record } from "./helpers/device-follow.ts";

test("a prior boot's journal cursor replays the running boot from its first record", async () => {
	const fixture = followFixture();
	const prior = `s=ab;b=${"b".repeat(32)};m=123`;
	fixture.rows.push(record(2));
	try {
		const result = await startFollow(
			fixture.conn,
			{ afterCursor: prior },
			fixture.options,
		);
		expect(result.ok).toBe(true);
		const child = fixture.children[0];
		if (!child) throw new Error("journal follower was not started");
		// journalctl includes its selected starting record.
		const rows = fixture.argv[0]?.includes("--cursor=s=2")
			? fixture.rows.slice(1)
			: fixture.rows;
		await child.emit(rows);
		fixture.time.advance(250);
		expect(
			fixture.messages.map(({ gap, entries }) => [
				gap,
				entries.map(({ cursor }) => cursor),
			]),
		).toEqual([[undefined, ["s=1", "s=2"]]]);
	} finally {
		await stopFollow(fixture.conn);
		fixture.restore();
	}
});
