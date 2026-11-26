/**
 * The out-of-date page check as a device runs it: the shipped entrypoint, its
 * own build identity, and real sockets that name a build on their URL the way a
 * page does. `ui-build-admission.test.ts` covers what each call answers; here
 * nothing is injected, so the check is off if any link between the stamp file
 * and the refused call is missing.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PASSWORD = "correct-password";
// Bounds on a busy machine: each wait ends on the device's answer, not on these.
const BOOT_MS = 30_000;
setDefaultTimeout(BOOT_MS);

type Frame = Record<string, unknown>;
type Device = { readonly port: number; stop(): Promise<void> };

/** Boot the entrypoint where an install left `stamp`, with `env` in its environment. */
async function bootDevice(
	stamp: string | undefined,
	env: string | undefined,
): Promise<Device> {
	const cwd = mkdtempSync(join(tmpdir(), "ui-build-wiring-"));
	const { CERAUI_BUILD_ID: _inherited, ...inherited } = process.env;
	const ready = Promise.withResolvers<number>();
	const log = join(cwd, "device.log");
	const output = openSync(log, "w");
	const child = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("./helpers/ui-build-server.ts", import.meta.url)),
		],
		{
			cwd,
			env: {
				...inherited,
				NODE_ENV: "development",
				TEST_CONFIG: JSON.stringify({ max_br: 6000 }),
				...(stamp === undefined ? {} : { TEST_BUILD_STAMP: stamp }),
				...(env === undefined ? {} : { CERAUI_BUILD_ID: env }),
			},
			stdin: "ignore",
			stdout: output,
			stderr: output,
			ipc: (message: { port: number }) => ready.resolve(message.port),
		},
	);
	closeSync(output);
	void child.exited.then((code) => {
		const said = readFileSync(log, "utf8").slice(-2000);
		ready.reject(
			new Error(`device exited ${code} before it was ready: ${said}`),
		);
	});
	return {
		port: await ready.promise,
		stop: async () => {
			child.kill("SIGKILL");
			await child.exited;
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/** A page on a socket of its own, signed in, naming `build` the way its URL does. */
async function signIn(device: Device, build: string | undefined) {
	const query = build === undefined ? "" : `?ui_build=${build}`;
	const socket = new WebSocket(`ws://127.0.0.1:${device.port}/ws${query}`);
	const frames: Frame[] = [];
	const answers = new Map<string, (frame: Frame) => void>();
	socket.onmessage = ({ data }) => {
		const frame = JSON.parse(String(data)) as Frame;
		frames.push(frame);
		answers.get(String(frame.id))?.(frame);
	};
	const opened = Promise.withResolvers<void>();
	socket.onopen = () => opened.resolve();
	socket.onerror = () => opened.reject(new Error("socket refused"));
	await opened.promise;

	const call = (path: string, input?: unknown) => {
		const id = `${path}-${answers.size}`;
		const answer = Promise.withResolvers<Frame>();
		answers.set(id, answer.resolve);
		socket.send(JSON.stringify({ id, path: path.split("."), input }));
		return answer.promise;
	};
	expect(
		await call("auth.login", { password: PASSWORD, persistent_token: false }),
	).toMatchObject({ result: { success: true } });
	const notifications = () =>
		frames.flatMap((frame) =>
			frame.notification === undefined
				? []
				: [
						frame.notification as {
							show?: Array<{ name: string; key?: string; msg: string }>;
							remove?: Array<{ id: string }>;
						},
					],
		);
	return {
		call,
		close: () => socket.close(),
		shown: () =>
			notifications()
				.flatMap(({ show }) => show ?? [])
				.filter(({ name }) => name === "ui-out-of-date")
				.map(({ key, msg }) => ({ key, msg })),
		withdrawn: () =>
			notifications()
				.flatMap(({ remove }) => remove ?? [])
				.filter(({ id }) => id === "ui-out-of-date").length,
	};
}

const NOTICE = {
	key: "notifications.uiOutOfDate",
	msg: "This page is out of date. Reload to continue.",
};
const isStreaming = async (device: Device) =>
	(await (await fetch(`http://127.0.0.1:${device.port}/status`)).json())
		.is_streaming;

describe.each([
	["an installed stamp, over the environment", "build-a", "build-env"],
	["the environment, with no stamp", undefined, "build-a"],
])("a device whose build comes from %s", (_where, stamp, env) => {
	let device: Device;

	beforeAll(async () => {
		device = await bootDevice(stamp, env);
	}, BOOT_MS);
	afterAll(() => device?.stop());

	test("admits the page of its own build, and withdraws the notice an earlier build left on it", async () => {
		const page = await signIn(device, "build-a");

		expect(
			await page.call("streaming.setConfig", { max_br: 5000 }),
		).toMatchObject({ result: { success: true } });
		// The sign-in's own frame is decided before a later call is, so it is here by now.
		expect(page.shown()).toEqual([]);
		expect(page.withdrawn()).toBe(1);
		expect(await page.call("streaming.start", {})).toMatchObject({
			result: { success: true, is_streaming: true },
		});
		expect(await isStreaming(device)).toBe(true);
		await page.call("streaming.stop");
		expect(await isStreaming(device)).toBe(false);
		expect(
			await page.call("streaming.setConfig", { max_br: 6000 }),
		).toMatchObject({ result: { success: true } });
		page.close();
	});

	test.each([
		["of another build", "build-b"],
		["that names an empty build", ""],
		["that names none", undefined],
	])(
		"tells the page %s to reload at sign-in, and refuses its writes and its Start",
		async (_which, build) => {
			const page = await signIn(device, build);

			expect(
				await page.call("streaming.setConfig", { max_br: 5000 }),
			).toMatchObject({ error: { message: NOTICE.msg } });
			// One at sign-in, one at the refused write.
			expect(page.shown()).toEqual([NOTICE, NOTICE]);
			expect(await page.call("streaming.start", {})).toMatchObject({
				result: {
					success: false,
					is_streaming: false,
					error: "UI_OUT_OF_DATE",
				},
			});
			expect(page.shown()).toEqual([NOTICE, NOTICE, NOTICE]);
			expect(page.withdrawn()).toBe(0);
			expect(await isStreaming(device)).toBe(false);
			expect(await page.call("streaming.getConfig")).toMatchObject({
				result: { max_br: 6000 },
			});
			page.close();
		},
	);
});

describe("a device with no build identity", () => {
	let device: Device;

	beforeAll(async () => {
		device = await bootDevice(undefined, undefined);
	}, BOOT_MS);
	afterAll(() => device?.stop());

	test.each([
		["that names a build", "build-b"],
		["that names none", undefined],
	])(
		"admits the page %s, and withdraws a notice left on it",
		async (_which, build) => {
			const page = await signIn(device, build);

			expect(
				await page.call("streaming.setConfig", { max_br: 5000 }),
			).toMatchObject({ result: { success: true } });
			expect(page.shown()).toEqual([]);
			expect(page.withdrawn()).toBe(1);
			page.close();
		},
	);
});
