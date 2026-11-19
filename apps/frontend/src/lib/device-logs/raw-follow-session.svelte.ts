import {
	followCheckpointBoot,
	LOG_FOLLOW_BOOT_START_PREFIX,
	type LogFollowMessage,
	type LogFollowStopOutput,
} from "@ceraui/rpc/schemas";
import type { RawFeedback } from "./raw-feedback.svelte";
import { followInput, type RawFilter } from "./raw-filter";
import type { RawRowWindow } from "./raw-row-window.svelte";
import { type RawViewDeps, READ_FAILED, settleRawRpc } from "./raw-view-rpc";

export type FollowState =
	| "idle"
	| "starting"
	| "following"
	| "paused"
	| "stopped"
	| "disconnected";

type StartAnnouncement = "following" | "resumed" | null;

/** The device head learned by starting without a position. */
export interface FollowFence {
	readonly head: string;
	readonly announce: StartAnnouncement;
}

interface FollowContext {
	readonly rows: RawRowWindow;
	readonly feedback: RawFeedback;
	filter(): RawFilter;
	canFollow(): boolean;
	isDisposed(): boolean;
	preparePagingForFollow(): void;
	readHead(fence?: FollowFence): Promise<void>;
}

// The socket has one follower and one listener slot. Only the latest owner
// may stop the device or clear that slot. The token does not retain the view.
let followOwner: object | undefined;

/** Owns the lifetime and resume position of one view's subscription. */
export class RawFollowSession {
	state = $state<FollowState>("idle");
	ended = $state<NonNullable<LogFollowMessage["ended"]> | null>(null);
	busy = $state(false);
	connected = $state(true);
	#token = 0;
	readonly #owner = {};
	#subscription: string | null = null;
	#queued: LogFollowMessage[] | null = null;
	#checkpoint: string | null = null;

	constructor(
		private readonly deps: Pick<
			RawViewDeps,
			"logs" | "readCurrentBoot" | "setFollowListener"
		>,
		private readonly context: FollowContext,
	) {}

	get #live(): boolean {
		return this.state === "following" || this.state === "starting";
	}

	/** Follow or Resume from the last resumable position, else the newest row. */
	async start(): Promise<void> {
		if (
			this.state === "following" ||
			this.busy ||
			!this.connected ||
			!this.context.canFollow()
		)
			return;
		await this.#attach(
			this.state === "paused" || this.state === "disconnected"
				? "resumed"
				: "following",
		);
	}

	/** Batches sent before the device confirms the stop still apply. */
	async pause(): Promise<void> {
		if (this.state !== "following" || this.busy) return;
		const token = this.#token;
		this.state = "paused";
		this.busy = true;
		this.context.feedback.announce("paused");
		const reply = await this.#stop();
		if (token !== this.#token) return;
		this.#checkpoint = reply?.checkpointCursor ?? this.#checkpoint;
		this.#forget();
	}

	/** The device stops a socket's follow when the socket drops. */
	connectionChanged(state: string): void {
		const connected = state === "connected";
		if (connected === this.connected) return;
		this.connected = connected;
		if (this.state === "idle" || this.state === "stopped") return;
		if (connected) {
			void this.#checkBoot();
			return;
		}
		this.#forget();
		if (this.state === "paused") return;
		this.state = "disconnected";
		this.context.feedback.announce("disconnected");
	}

	async #checkBoot(): Promise<void> {
		const { readCurrentBoot } = this.deps;
		if (readCurrentBoot === undefined) return;
		const boot =
			followCheckpointBoot(this.#checkpoint) ?? this.context.rows.newestBoot;
		if (boot === undefined) return;
		const token = ++this.#token;
		this.busy = true;
		const current = await settleRawRpc(
			readCurrentBoot,
			undefined,
			"System Logs current boot read failed:",
		);
		if (token !== this.#token || this.context.isDisposed()) return;
		this.busy = false;
		if (current !== undefined && current !== boot) this.#end("boot_changed");
	}

	resetForFilter(): boolean {
		const live = this.detach();
		if (!live) this.#forget();
		this.state = "idle";
		this.ended = null;
		this.#checkpoint = null;
		return live;
	}

	/** Stops and forgets the device follow; true when it was running or starting. */
	detach(): boolean {
		const live = this.#live;
		if (!live && this.#subscription === null) return false;
		if (this.#subscription !== null || this.state === "starting")
			void this.#stop();
		this.#forget();
		return live;
	}

	setHeadPosition(cursor: string): void {
		this.#checkpoint = cursor;
	}

	/** Continue from the resume position, or the head learned while bootstrapping. */
	async afterHeadRead(
		live: boolean,
		refollow: boolean,
		fence?: FollowFence,
	): Promise<void> {
		this.busy = false;
		if (fence !== undefined) {
			// A failed read proves nothing: the next Follow learns the head again.
			if (this.context.feedback.failure?.op === "first") {
				if (this.state === "starting") this.state = "idle";
				return;
			}
			this.#checkpoint ??= fence.head;
		}
		if (live && this.#live)
			await this.#attach(
				fence?.announce ?? (this.state === "starting" ? "following" : null),
			);
		else if (refollow) await this.start();
	}

	async #attach(announce: StartAnnouncement): Promise<void> {
		if (this.context.isDisposed()) return;
		this.context.preparePagingForFollow();
		const token = ++this.#token;
		followOwner = this.#owner;
		this.state = "starting";
		this.busy = true;
		this.ended = null;
		const { feedback, rows } = this.context;
		if (feedback.failure?.op === "follow") feedback.failure = null;
		this.#subscription = null;
		this.#queued = [];
		this.deps.setFollowListener(this.#receive);
		const position = this.#checkpoint ?? rows.newest;
		const input = followInput(this.context.filter(), position);
		const reply = await settleRawRpc(
			() => this.deps.logs.followStart(input),
			READ_FAILED,
			"System Logs follow start failed:",
		);
		if (token !== this.#token) {
			// A start that lands after unmount still runs on the device.
			if (reply.ok && this.context.isDisposed()) void this.#stop();
			return;
		}
		const queued = this.#queued ?? [];
		this.#queued = null;
		this.busy = false;
		if (!reply.ok) {
			this.#forget();
			this.state = "idle";
			feedback.failure = { code: reply.error, op: "follow" };
			return;
		}
		const previousBoot = followCheckpointBoot(position) ?? rows.newestBoot;
		const runningBoot = followCheckpointBoot(reply.checkpointCursor);
		if (
			previousBoot !== undefined &&
			runningBoot !== undefined &&
			runningBoot !== previousBoot
		) {
			void this.#stop();
			this.#end("boot_changed");
			return;
		}
		// The device may have written entries since the last read. Re-read before
		// attaching beyond the learned head, unless the watch starts at boot start.
		if (
			position === null &&
			reply.checkpointCursor !== null &&
			!reply.checkpointCursor.startsWith(LOG_FOLLOW_BOOT_START_PREFIX)
		)
			return this.context.readHead({ head: reply.checkpointCursor, announce });
		this.#subscription = reply.subscriptionId;
		this.#checkpoint = reply.checkpointCursor ?? this.#checkpoint;
		this.state = "following";
		if (announce !== null) feedback.announce(announce);
		for (const message of queued) this.#receive(message);
	}

	readonly #receive = (message: LogFollowMessage): void => {
		// Clear logs ends every follow, even before the reply names this one.
		if (message.ended === "cleared") {
			this.#end("cleared");
			return;
		}
		if (this.#queued !== null) {
			this.#queued.push(message);
			return;
		}
		if (message.subscriptionId !== this.#subscription) return;
		this.#checkpoint = message.checkpointCursor ?? this.#checkpoint;
		const { rows, feedback } = this.context;
		const added = rows.appendBatch(message);
		if (message.gap !== undefined || message.dropped > 0)
			feedback.announce("gap");
		else feedback.announceNew(added);
		if (message.ended !== undefined) this.#end(message.ended);
	};

	#end(reason: NonNullable<LogFollowMessage["ended"]>): void {
		this.#forget();
		this.state = "stopped";
		this.ended = reason;
		this.context.feedback.announce("stopped");
		if (reason !== "cleared" && reason !== "boot_changed") return;
		this.#checkpoint = null;
		void this.context.readHead();
	}

	/** Detaches this view from the device follow; late replies become stale. */
	#forget(): void {
		this.#token += 1;
		this.#subscription = null;
		this.#queued = null;
		this.busy = false;
		if (followOwner === this.#owner) this.deps.setFollowListener(undefined);
	}

	#stop(): Promise<LogFollowStopOutput | null> {
		return followOwner === this.#owner
			? settleRawRpc(
					() => this.deps.logs.followStop(),
					null,
					"System Logs follow stop failed:",
				)
			: Promise.resolve(null);
	}
}
