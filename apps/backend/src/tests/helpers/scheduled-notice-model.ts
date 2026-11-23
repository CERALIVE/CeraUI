import type { AptPackage, AptScript } from "./ceralive-update-apt.ts";

export type Fact =
	| "pending"
	| "installed"
	| "held"
	| "pinned"
	| "partial"
	| "failed"
	| "truncated"
	| "missing"
	| "downgrade"
	| "newer"
	| "reinstall";
export type Operation =
	| { readonly kind: "check"; readonly fact: Fact }
	| { readonly kind: "restart"; readonly main: boolean }
	| { readonly kind: "open" | "auth" | "disconnect" | "dismiss" };

export const offer: AptPackage = {
	name: "cerastream",
	installed: "1",
	candidate: "2",
};
export const installed = { ...offer, installed: "2" };

export function device(fact: Fact): AptScript {
	switch (fact) {
		case "pending":
			return { upgradable: [offer] };
		case "reinstall":
			return { upgradable: [installed] };
		case "installed":
			return { installed: [installed] };
		case "held":
			return { installed: [installed], holds: [offer.name] };
		case "pinned":
			return { installed: [{ ...offer, candidate: "1" }] };
		case "partial":
			return { installed: [installed], dpkgStatus: { cerastream: "iF " } };
		case "failed":
			return {
				installed: [installed],
				refresh: { exitCode: 100, stderr: "E: failed refresh\n" },
			};
		case "truncated":
			return {
				installed: [installed],
				proof: { "dpkg-query": { stdout: "cerastream\tarm64\tii \t2" } },
			};
		case "missing":
			return {};
		case "downgrade":
			return { installed: [{ ...offer, installed: "3" }] };
		case "newer":
			return { installed: [{ ...offer, installed: "3", candidate: "3" }] };
	}
}

// Oracle over semantic fixtures, not the bytes in device(), or the production
// parser. No installation verdict follows from a missing offer in an APT plan.
export function attained(fact: Fact): boolean {
	return fact === "installed";
}

const facts = [
	"pending",
	"installed",
	"held",
	"pinned",
	"partial",
	"failed",
	"truncated",
	"missing",
	"downgrade",
	"newer",
	"reinstall",
] as const;

export function generate(seed: number): Operation[] {
	let state = seed >>> 0 || 1;
	const pick = <T>(choices: readonly [T, ...T[]]): T => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return choices[(state >>> 0) % choices.length] ?? choices[0];
	};
	const trace: Operation[] = [{ kind: "check", fact: "pending" }];
	for (let i = 0; i < 12; i++) {
		switch (
			pick([
				"check",
				"check",
				"check",
				"restart",
				"disconnect",
				"open",
				"auth",
				"dismiss",
			])
		) {
			case "check":
				trace.push({ kind: "check", fact: pick(facts) });
				break;
			case "restart":
				trace.push({ kind: "restart", main: pick([true, false]) });
				break;
			case "disconnect":
				trace.push({ kind: "disconnect" });
				break;
			case "open":
				trace.push({ kind: "open" });
				break;
			case "auth":
				trace.push({ kind: "auth" });
				break;
			case "dismiss":
				trace.push({ kind: "dismiss" });
				break;
		}
	}
	return [
		...trace,
		{ kind: "open" },
		{ kind: "auth" },
		{ kind: "check", fact: "installed" },
	];
}

// Only the same observed invariant can shrink a failure. Infrastructure
// errors propagate instead of becoming a seemingly smaller counterexample.
export async function shrink(
	trace: readonly Operation[],
	stillFails: (candidate: readonly Operation[]) => Promise<boolean>,
): Promise<readonly Operation[]> {
	let out = trace;
	for (
		let width = Math.ceil(out.length / 2);
		width >= 1;
		width = Math.floor(width / 2)
	) {
		for (let i = 0; i + width <= out.length; ) {
			const candidate = [...out.slice(0, i), ...out.slice(i + width)];
			if (await stillFails(candidate)) out = candidate;
			else i++;
		}
	}
	return out;
}
