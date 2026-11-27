import { expect, test } from "bun:test";
import {
	all,
	firstOnly,
	inAutoMode,
	restart,
	sortedSenders,
	toggle,
	useGuard,
	useObserver,
} from "./helpers/bond-port-boot-window-fixture.ts";
import { installBondPortFixture } from "./helpers/bond-port-record-fixture.ts";

installBondPortFixture();

test.each(["real", "emulated", "errored"] as const)(
	"an ON acknowledged without a serial survives the next %s boot probe",
	async (next) => {
		await inAutoMode(async () => {
			const settleFirst = useObserver();
			await toggle("first", false);
			await settleFirst("emulated");
			const settleSecond = useObserver();
			await restart("");
			await settleSecond("emulated");
			await toggle("first", true);
			expect(sortedSenders()).toEqual(firstOnly);
			const settleThird = useObserver();
			await restart();
			const pending = sortedSenders();
			await settleThird(next);
			expect({ pending, settled: sortedSenders() }).toEqual({
				pending: firstOnly,
				settled: firstOnly,
			});
		});
	},
);

test.each([true, false])(
	"a forced-emulation ON without a serial survives a real boot (previous ON: %j)",
	async (previousOn) => {
		await inAutoMode(async () => {
			useGuard();
			await toggle("first", true);
			if (!previousOn) await toggle("first", false);
			const expected = previousOn ? all : firstOnly;
			process.env.CERALIVE_DEVICE_TYPE = "emulated";
			try {
				await (previousOn ? restart(undefined, "") : restart(""));
				await toggle(previousOn ? "second" : "first", true);
				expect(sortedSenders()).toEqual(expected);
			} finally {
				delete process.env.CERALIVE_DEVICE_TYPE;
			}
			await restart();
			expect(sortedSenders()).toEqual(expected);
		});
	},
);
