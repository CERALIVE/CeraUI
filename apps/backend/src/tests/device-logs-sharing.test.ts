import { expect, test } from "bun:test";
import { reserveLogSharing } from "../modules/device-logs/sharing.ts";

test("sharing reservations expire exactly at sixty seconds", () => {
	const first = reserveLogSharing(100);
	if (!first) throw new Error("sharing was unexpectedly occupied");
	expect(reserveLogSharing(60_099)).toBeNull();
	const second = reserveLogSharing(60_100);
	if (!second) throw new Error("sharing did not expire");
	first.release();
	expect(reserveLogSharing(60_100)).toBeNull();
	second.release();
});
test("active sharing survives expiry and a stale release cannot retire its successor", () => {
	const first = reserveLogSharing(100);
	if (!first) throw new Error("sharing was unexpectedly occupied");
	first.start();
	expect(reserveLogSharing(10_000_000)).toBeNull();
	first.release();
	const second = reserveLogSharing(10_000_000);
	if (!second) throw new Error("sharing did not release");
	first.release();
	expect(reserveLogSharing(10_000_001)).toBeNull();
	second.release();
});
