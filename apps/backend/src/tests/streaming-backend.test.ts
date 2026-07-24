import { describe, expect, test } from "bun:test";

import type {
	BackendErrorListener,
	BitrateParams,
	StreamingBackend,
	StreamRunOptions,
} from "../modules/streaming/streaming-backend.ts";

// Contract test for the StreamingBackend seam. It pins the call sequencing every
// engine implementation must honour, using a fully in-memory fake — no IPC, no
// real engine. The CONCRETE CerastreamBackend is verified to structurally
// satisfy the same interface at the end so the seam can't drift away from a real
// implementation.

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "stream-1",
};

const HW_MIN = 300;
const HW_MAX = 12_000;

type Call =
	| { op: "writeConfig" }
	| { op: "buildRunArgs" }
	| { op: "start" }
	| { op: "stop" }
	| { op: "setBitrate"; value: number | undefined }
	| { op: "reloadConfig" };

class FakeBackend implements StreamingBackend {
	readonly execPath = "/usr/bin/fake-engine";
	readonly tempPipelinePath = "/tmp/fake-pipeline.txt";
	readonly configPath = "/tmp/fake.conf";

	readonly calls: Array<Call> = [];
	private readonly errorListeners: Array<BackendErrorListener> = [];
	private engineRunning = false;

	configExists(): boolean {
		return true;
	}

	writeConfig(): string {
		this.calls.push({ op: "writeConfig" });
		return this.configPath;
	}

	buildRunArgs(): Array<string> {
		this.calls.push({ op: "buildRunArgs" });
		return ["--config", this.configPath];
	}

	async start(
		_config: Parameters<StreamingBackend["start"]>[0],
		_opts: Parameters<StreamingBackend["start"]>[1],
	): Promise<void> {
		this.calls.push({ op: "start" });
		this.engineRunning = true;
	}

	stop(onStopped: () => void): boolean {
		this.calls.push({ op: "stop" });
		if (!this.engineRunning) return false;
		this.engineRunning = false;
		onStopped();
		return true;
	}

	setBitrate(params: BitrateParams): number | undefined {
		const value =
			typeof params.max_br === "number" &&
			params.max_br >= HW_MIN &&
			params.max_br <= HW_MAX
				? params.max_br
				: undefined;
		this.calls.push({ op: "setBitrate", value });
		if (value !== undefined) {
			this.writeConfig();
			this.reloadConfig();
		}
		return value;
	}

	reloadConfig(): void {
		this.calls.push({ op: "reloadConfig" });
	}

	onError(listener: BackendErrorListener): void {
		this.errorListeners.push(listener);
	}

	emitError(raw: string): void {
		for (const listener of this.errorListeners) listener(raw);
	}
}

describe("StreamingBackend contract", () => {
	test("start → setBitrate → stop fire in the order the session drives them", async () => {
		const backend = new FakeBackend();

		await backend.start(
			{ max_br: 8000 } as Parameters<StreamingBackend["start"]>[0],
			RUN_OPTS,
		);
		backend.setBitrate({ max_br: 9000 });

		let stopped = false;
		const found = backend.stop(() => {
			stopped = true;
		});

		expect(found).toBe(true);
		expect(stopped).toBe(true);
		expect(backend.calls.map((c) => c.op)).toEqual([
			"start",
			"setBitrate",
			"writeConfig",
			"reloadConfig",
			"stop",
		]);
	});

	test("setBitrate persists + reloads on a valid value, returns it", () => {
		const backend = new FakeBackend();
		const applied = backend.setBitrate({ max_br: 6000 });

		expect(applied).toBe(6000);
		expect(backend.calls.map((c) => c.op)).toEqual([
			"setBitrate",
			"writeConfig",
			"reloadConfig",
		]);
	});

	test("setBitrate rejects an out-of-window value without a write/reload", () => {
		const backend = new FakeBackend();
		const applied = backend.setBitrate({ max_br: HW_MAX + 1 });

		expect(applied).toBeUndefined();
		expect(backend.calls.map((c) => c.op)).toEqual(["setBitrate"]);
	});

	test("stop on an idle engine reports not-found and never signals onStopped", () => {
		const backend = new FakeBackend();
		let stopped = false;
		const found = backend.stop(() => {
			stopped = true;
		});

		expect(found).toBe(false);
		expect(stopped).toBe(false);
	});

	test("onError fans classified engine errors out to registered listeners", () => {
		const backend = new FakeBackend();
		const seen: Array<string> = [];
		backend.onError((raw) => seen.push(raw));

		backend.emitError("Pipeline stall detected");

		expect(seen).toEqual(["Pipeline stall detected"]);
	});
});

describe("CerastreamBackend satisfies the contract", () => {
	test("the production singleton structurally implements StreamingBackend", async () => {
		const { cerastreamBackend } = await import(
			"../modules/streaming/cerastream-backend.ts"
		);

		const impl: StreamingBackend = cerastreamBackend;
		expect(typeof impl.start).toBe("function");
		expect(typeof impl.stop).toBe("function");
		expect(typeof impl.setBitrate).toBe("function");
		expect(typeof impl.reloadConfig).toBe("function");
		expect(typeof impl.writeConfig).toBe("function");
		expect(typeof impl.buildRunArgs).toBe("function");
		expect(typeof impl.configExists).toBe("function");
		expect(typeof impl.onError).toBe("function");
		expect(typeof impl.execPath).toBe("string");
		expect(typeof impl.tempPipelinePath).toBe("string");
		expect(typeof impl.configPath).toBe("string");
	});
});
