import { describe, expect, test } from "vitest";

import { createLiveProgress } from "./live-progress";

const installing = { total: 1, downloading: 0, unpacking: 0, setting_up: 1 };

describe("createLiveProgress", () => {
	test("a number is shown only while it is live on this connection", () => {
		const live = createLiveProgress();
		const at60 = { ...installing, percent: 60 };
		const frame = { updating: at60 };
		expect(live(at60, frame, false)).toEqual(at60);
		// The connection drops: the held number is no longer live.
		expect(live(at60, frame, true)).toEqual(installing);
		// Back, but the device has sent nothing new yet.
		expect(live(at60, frame, false)).toEqual(installing);
		// A new frame on this connection is live again.
		const at80 = { ...installing, percent: 80 };
		expect(live(at80, { updating: at80 }, false)).toEqual(at80);
	});

	test("a phase without a number and no install pass through", () => {
		const live = createLiveProgress();
		expect(live(installing, {}, true)).toEqual(installing);
		expect(live(undefined, undefined, true)).toBeUndefined();
	});
});
