import { describe, expect, test } from "vitest";

import { createLiveProgress } from "./live-progress";

const installing = { total: 1, downloading: 0, unpacking: 0, setting_up: 1 };

describe("createLiveProgress", () => {
	test("a number is shown only while it is live on this connection", () => {
		const live = createLiveProgress();
		const at60 = { ...installing, percent: 60 };
		expect(live(at60, at60, true)).toEqual(at60);
		// The connection drops: the held number is no longer live.
		expect(live(at60, at60, false)).toEqual(installing);
		// Back, but the device has sent nothing on this link yet.
		expect(live(at60, at60, false)).toEqual(installing);
		// A new frame on this connection is live again.
		const at80 = { ...installing, percent: 80 };
		expect(live(at80, at80, true)).toEqual(at80);
	});

	test("the same frame sent again on the new link shows its number again", () => {
		const live = createLiveProgress();
		const at60 = { ...installing, percent: 60 };
		live(at60, at60, true);
		expect(live(at60, at60, false)).toEqual(installing);
		// The device delivered it on this link: unchanged, but current.
		expect(live(at60, at60, true)).toEqual(at60);
	});

	test("a lower number after an unknown one in the same phase is never shown", () => {
		const live = createLiveProgress();
		const at60 = { ...installing, percent: 60 };
		live(at60, at60, true);
		// The device says it does not know the number now.
		expect(live(installing, installing, true)).toEqual(installing);
		// A fresh 40 is below what this phase already showed.
		const at40 = { ...installing, percent: 40 };
		expect(live(at40, at40, true)).toEqual(installing);
		// At or above it, the device's own number is live again.
		const at70 = { ...installing, percent: 70 };
		expect(live(at70, at70, true)).toEqual(at70);
	});

	test("after a drop, a number the device did not send again is never shown", () => {
		const live = createLiveProgress();
		const at60 = { ...installing, percent: 60 };
		live(at60, at60, true);
		live(at60, at60, false);
		// The device's fresh frame says 40; the hold keeps 60, which nobody sent now.
		const at40 = { ...installing, percent: 40 };
		expect(live(at60, at40, true)).toEqual(installing);
		// A lower phase without a number cannot bring the old number back either.
		const downloading = {
			total: 1,
			downloading: 1,
			unpacking: 0,
			setting_up: 0,
		};
		expect(live(at60, downloading, true)).toEqual(installing);
		// The same number in another phase is not this number.
		const downloading60 = { ...downloading, percent: 60 };
		expect(live(at60, downloading60, true)).toEqual(installing);
		// Once the device sends the number shown, it is live.
		const again60 = { ...installing, percent: 60 };
		expect(live(at60, again60, true)).toEqual(at60);
	});

	test("a phase without a number and no install pass through", () => {
		const live = createLiveProgress();
		expect(live(installing, {}, false)).toEqual(installing);
		expect(live(undefined, undefined, false)).toBeUndefined();
	});
});
