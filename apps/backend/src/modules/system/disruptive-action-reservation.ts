/// <reference lib="es2023.collection" />
import { SpawnTimeoutError } from "../../helpers/bounded-spawn.ts";
import type {
	DisruptiveActionDecision,
	UpdateBusyReason,
} from "./disruptive-action-gate.ts";

export type DisruptiveRefusalReason = Extract<
	DisruptiveActionDecision,
	{ allowed: false }
>["reason"];

export class DisruptiveActionRefusal extends Error {
	override readonly name = "DisruptiveActionRefusal";
	constructor(readonly reason: DisruptiveRefusalReason) {
		super(reason);
	}
}

export class PowerSubmissionError extends Error {
	override readonly name = "PowerSubmissionError";
	constructor(
		readonly command: string,
		readonly exitCode: number | null,
	) {
		super(`${command} exited with status ${String(exitCode)}`);
	}
}

export type DisruptiveReservation = {
	readonly releaseAfterFailure: () => void;
	readonly releaseAfterCompletion: () => void;
	readonly active: () => boolean;
	readonly retained: () => boolean;
	readonly markUncertain: () => void;
};
export type DisruptiveReservationOutcome =
	| { readonly allowed: true; readonly reservation: DisruptiveReservation }
	| Extract<DisruptiveActionDecision, { allowed: false }>;

export type PowerAction = "reboot" | "poweroff" | "factory-reset";
type Holder = {
	readonly owner: symbol;
	readonly lifetime: "shutdown" | "service";
	readonly tickets: Set<symbol>;
	readonly uncertainTickets: Set<symbol>;
	readonly powerAction?: PowerAction;
	previous: Holder | undefined;
};
let pending: Holder | undefined;
let retiredOwners = new WeakSet<symbol>();
let readUpdateBusy: () => readonly UpdateBusyReason[] = () => [
	"update-recovery",
];

export function setDisruptiveUpdateBusySource(
	read?: () => readonly UpdateBusyReason[],
): void {
	readUpdateBusy = read ?? (() => ["update-recovery"]);
}
export function readDisruptiveUpdateBusy(): readonly UpdateBusyReason[] {
	return readUpdateBusy();
}

export function isDisruptiveActionPending(): boolean {
	return pending !== undefined;
}

export function isActiveDisruptiveOwner(owner: symbol): boolean {
	return (
		pending?.owner === owner &&
		pending.uncertainTickets.size === 0 &&
		pending.tickets.size > 0
	);
}

export function pendingPowerOwner(action: PowerAction): symbol | undefined {
	return pending?.lifetime === "shutdown" && pending.powerAction === action
		? pending.owner
		: undefined;
}

export function assertDisruptiveActionFree(): void {
	if (isDisruptiveActionPending())
		throw new DisruptiveActionRefusal("update_in_progress");
}

// Exit statuses at or above 128 are how shells and runtimes report a child
// killed by a signal (137 = SIGKILL). A killed sudo says nothing about the
// helper or systemd-sysext it may have left reparented, so a signal is not a
// verdict: only ordinary small exits and pre-spawn errno prove nothing ran on.
const SIGNAL_EXIT_FLOOR = 128;

function isOrdinaryExit(status: number): boolean {
	return status > 0 && status < SIGNAL_EXIT_FLOOR;
}

function carriesSignal(error: Error): boolean {
	return ["signalCode", "signal"].some((field) => {
		const value: unknown = Reflect.get(error, field);
		return typeof value === "string" && value !== "";
	});
}

export function isPositiveDisruptiveFailure(error: unknown): boolean {
	if (error instanceof SpawnTimeoutError) return false;
	if (error instanceof PowerSubmissionError)
		return error.exitCode !== null && isOrdinaryExit(error.exitCode);
	if (!(error instanceof Error) || carriesSignal(error)) return false;
	const code: unknown = Reflect.get(error, "code");
	return (
		(typeof code === "number" && isOrdinaryExit(code)) ||
		(typeof code === "string" &&
			["ENOENT", "EACCES", "ENOEXEC", "E2BIG"].includes(code))
	);
}

export function reserveDisruptiveAction(
	decision: DisruptiveActionDecision,
	lifetime: "shutdown" | "service" = "shutdown",
	owner?: symbol,
): DisruptiveReservationOutcome {
	if (!decision.allowed) return decision;
	if (owner !== undefined && retiredOwners.has(owner))
		return { allowed: false, reason: "update_in_progress" };
	if (pending !== undefined) {
		if (
			owner === undefined ||
			!isActiveDisruptiveOwner(owner) ||
			pending.lifetime !== lifetime
		)
			return { allowed: false, reason: "update_in_progress" };
		return acquireTicket(pending);
	}
	pending = {
		owner: owner ?? Symbol("disruptive-action"),
		lifetime,
		tickets: new Set(),
		uncertainTickets: new Set(),
		previous: undefined,
	};
	return acquireTicket(pending);
}

export function reservePowerAction(
	decision: DisruptiveActionDecision,
	action: PowerAction,
): DisruptiveReservationOutcome {
	if (!decision.allowed) return decision;
	if (pending !== undefined && pendingPowerOwner(action) === undefined)
		return { allowed: false, reason: "update_in_progress" };
	pending = {
		owner: Symbol(action),
		lifetime: "shutdown",
		powerAction: action,
		tickets: new Set(),
		uncertainTickets: new Set(),
		previous: pending,
	};
	return acquireTicket(pending);
}

function acquireTicket(holder: Holder): DisruptiveReservationOutcome {
	const ticket = Symbol("depth");
	holder.tickets.add(ticket);
	const active = () => pending === holder && holder.tickets.has(ticket);
	const retained = () => {
		for (let current = pending; current; current = current.previous) {
			if (current === holder) return holder.tickets.has(ticket);
		}
		return false;
	};
	const release = () => {
		if (!active()) return;
		holder.tickets.delete(ticket);
		holder.uncertainTickets.delete(ticket);
		if (holder.tickets.size === 0) {
			retiredOwners.add(holder.owner);
			pending = holder.previous;
		}
	};
	return {
		allowed: true,
		reservation: {
			active,
			retained,
			markUncertain: () => {
				if (active()) holder.uncertainTickets.add(ticket);
			},
			releaseAfterFailure: release,
			releaseAfterCompletion: () => {
				if (holder.lifetime === "service") release();
				else if (active()) {
					for (
						let previous = holder.previous;
						previous;
						previous = previous.previous
					)
						retiredOwners.add(previous.owner);
					holder.previous = undefined;
				}
			},
		},
	};
}

export function resetDisruptiveActionReservationForTest(): void {
	pending = undefined;
	retiredOwners = new WeakSet<symbol>();
}
