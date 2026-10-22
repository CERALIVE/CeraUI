import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";

export const APT_SIMULATION_VERSION_RE = /^[0-9][A-Za-z0-9.+:~-]*$/;

export type AptSimulationRow =
	| {
			readonly kind: "Inst";
			readonly name: string;
			readonly version: string | undefined;
	  }
	| { readonly kind: "Conf"; readonly name: string }
	| { readonly kind: "Remv" | "Purg"; readonly name: string };

// apt 3.0.3 algorithms.cc:82-269; pkgcache.cc:909-960. Release display is
// context, not repository authority; ambiguous/control-bearing displays refuse.
const CANDIDATE =
	/^ \(([0-9][A-Za-z0-9.+:~-]*) (?:([^\p{Cc}\p{Cf};[\]]*) \[[a-z0-9][a-z0-9-]*\])?\)/u;
const FULL_NAME = /^[a-z0-9][a-z0-9+.-]*:[a-z0-9][a-z0-9-]*$/;

export function parseAptSimulationRow(line: string): AptSimulationRow | null {
	const head = /^(Inst|Conf|Remv|Purg) (\S+)/.exec(line);
	const verb = head?.[1];
	const name = head?.[2];
	if (!head || !name || !APT_PACKAGE_NAME_RE.test(name)) return null;
	let rest = line.slice(head[0].length);
	if (verb !== "Conf") {
		const current = /^ \[([0-9][A-Za-z0-9.+:~-]*)\]/.exec(rest);
		if (current) rest = rest.slice(current[0].length);
	}
	let version: string | undefined;
	if (verb === "Inst" || verb === "Conf") {
		const candidate = CANDIDATE.exec(rest);
		if (candidate) {
			version = candidate[1];
			rest = rest.slice(candidate[0].length);
		}
	}
	if (verb === "Inst") {
		while (rest.startsWith(" [")) {
			const note = /^ \[([^[\]]+) on ([^[\]]+)\]/.exec(rest);
			if (!note) break;
			if (!FULL_NAME.test(note[1] ?? "") || !FULL_NAME.test(note[2] ?? ""))
				return null;
			rest = rest.slice(note[0].length);
		}
	}
	if (rest !== "") {
		const broken = /^ \[([^[\]]*)\]$/.exec(rest)?.[1];
		if (broken === undefined) return null;
		// ShortBreaks prints one final space; older fixtures omit it (D511).
		const names = broken.endsWith(" ") ? broken.slice(0, -1) : broken;
		if (
			broken !== "" &&
			names.split(" ").some((item) => !APT_PACKAGE_NAME_RE.test(item))
		)
			return null;
	}
	switch (verb) {
		case "Inst":
			return { kind: verb, name, version };
		case "Conf":
			return { kind: verb, name };
		case "Remv":
		case "Purg":
			return { kind: verb, name };
		default:
			return null;
	}
}
