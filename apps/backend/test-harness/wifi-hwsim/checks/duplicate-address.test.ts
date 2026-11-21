import { expect, test } from "bun:test";
import { assertActiveApPair, waitForSettledPublication } from "./duplicate-address.ts";

test("a publication invalidated before settlement must wait for a new publication", async () => {
	let publish = () => {};
	let ready = false;
	let subscribed = false;
	let settled: Promise<void> | undefined;
	const first = Promise.withResolvers<void>();
	const checking = Promise.withResolvers<void>();
	const next = Promise.withResolvers<void>();
	const waiting = waitForSettledPublication(
		async () => {
			settled = first.promise;
			ready = true;
			publish();
		},
		(listener) => {
			publish = listener;
			subscribed = true;
			return () => {
				subscribed = false;
			};
		},
		() => {
			if (settled) checking.resolve();
			return settled;
		},
		() => {
			if (!ready) next.resolve();
			return ready;
		},
		() => "wlan2 and wlan4",
	);
	await checking.promise;
	ready = false;
	settled = undefined;
	first.resolve();
	await next.promise;
	expect(subscribed).toBe(true);
	ready = true;
	publish();
	await waiting;
	expect(subscribed).toBe(false);
});

test("the active NM snapshot must retain each AP on its own device after the second starts", () => {
	const pair = [
		{ ifname: "wlan2", uuid: "profile-a", ssid: "AP A" },
		{ ifname: "wlan4", uuid: "profile-b", ssid: "AP B" },
	] as const;
	expect(() => assertActiveApPair("profile-b:wlan4\n", pair)).toThrow("wlan2");
	expect(() => assertActiveApPair("profile-a:wlan4\nprofile-b:wlan2\n", pair)).toThrow("wlan2");
	expect(() => assertActiveApPair("profile-b:wlan4\nprofile-a:wlan2\n", pair)).not.toThrow();
});
