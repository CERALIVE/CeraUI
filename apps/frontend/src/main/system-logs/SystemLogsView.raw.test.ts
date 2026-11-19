// @vitest-environment jsdom
import type { LogFollowMessage } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import SystemLogsView from "./SystemLogsView.svelte";

const logs = vi.hoisted(() => ({
	getStorage: vi.fn(),
	query: vi.fn(),
	followStart: vi.fn(),
	followStop: vi.fn(),
}));
const follow = vi.hoisted(() => ({
	listener: undefined as ((message: LogFollowMessage) => void) | undefined,
}));

vi.mock("$lib/rpc/client", () => ({ rpc: { logs } }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: (
		listener: ((message: LogFollowMessage) => void) | undefined,
	) => {
		follow.listener = listener;
	},
}));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));

let media: MediaQueryControl | undefined;

// Keep the first Vite transform outside the DOM query budget.
beforeAll(async () => {
	await import("./RawLogsTab.svelte");
});

beforeEach(() => {
	media = installMediaQueries((query) => query === "(min-width: 1024px)");
	logs.getStorage.mockResolvedValue({});
	logs.query.mockResolvedValue({
		ok: true,
		entries: [],
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId: null,
	});
	logs.followStart.mockResolvedValue({
		ok: true,
		subscriptionId: "sub-1",
		checkpointCursor: null,
	});
	logs.followStop.mockResolvedValue({ success: true, checkpointCursor: null });
});

afterEach(() => {
	cleanup();
	media?.restore();
	vi.clearAllMocks();
});

const tab = (name: string) => screen.getByRole("tab", { name });

describe("SystemLogsView: Raw logs panel", () => {
	it("mounts the raw viewer only inside the selected Raw logs panel", async ({
		onTestFinished,
	}) => {
		const rawChunk = Promise.withResolvers<void>();
		vi.doMock(import("./RawLogsTab.svelte"), async (importOriginal) => {
			await rawChunk.promise;
			return importOriginal();
		});
		onTestFinished(async () => {
			rawChunk.resolve();
			await vi.dynamicImportSettled();
			vi.doUnmock("./RawLogsTab.svelte");
		});

		render(SystemLogsView);
		await screen.findByRole("tablist");
		expect(screen.queryByTestId("raw-logs")).toBeNull();
		expect(logs.query).not.toHaveBeenCalled();

		await fireEvent.click(tab(en.systemLogs.tabs.raw));
		const panel = screen.getByTestId("system-logs-panel-raw");
		const raw = within(panel);
		expect((await raw.findByRole("status")).ariaBusy).toBe("true");
		const viewer = raw.findByTestId("raw-logs", undefined, { timeout: 5_000 });
		rawChunk.resolve();
		expect(await viewer).toBeTruthy();
		expect(screen.getAllByTestId("raw-logs")).toHaveLength(1);
		const events = screen.getByTestId("system-logs-panel-events");
		expect(within(events).queryByTestId("raw-logs")).toBeNull();
		expect(events.childElementCount).toBe(0);
		await waitFor(() => expect(logs.query).toHaveBeenCalledTimes(1));
	});

	it("stops following when another tab of the view is selected", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");
		await fireEvent.click(tab(en.systemLogs.tabs.raw));
		await screen.findByTestId("raw-logs");
		await waitFor(() => expect(screen.queryByTestId("raw-loading")).toBeNull());
		await fireEvent.click(screen.getByTestId("raw-follow-button"));
		await screen.findByText(en.systemLogs.follow.following);

		await fireEvent.click(tab(en.systemLogs.tabs.events));
		expect(screen.queryByTestId("raw-logs")).toBeNull();
		expect(logs.followStop).toHaveBeenCalledTimes(1);
		expect(follow.listener).toBeUndefined();
	});
});
