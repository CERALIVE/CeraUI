/*
 * Regression guard for the SIGUSR2 udev-hotplug delivery mechanism.
 *
 * BUG (confirmed live on real hardware): the two hotplug udev rules signalled the
 * backend with `pkill -o -SIGUSR2 -f ceralive`. `pkill -f` substring-matches the
 * FULL command line of EVERY process. Avahi renames its own process title to
 * `avahi-daemon: registering [<hostname>.local]` once it registers a hostname;
 * this device's hostname is `ceralive.local`, so avahi-daemon's title contains
 * the substring "ceralive" and was caught by the same broad pkill. avahi-daemon
 * (no `Restart=`) died on every USB/audio hotplug and mDNS stayed dead until
 * reboot.
 *
 * FIX: deliver the signal through `systemctl kill --kill-whom=main
 * --signal=SIGUSR2 ceralive.service`, which targets exactly the unit's tracked
 * MAIN pid via its cgroup — never another process. `--kill-whom=main` also
 * preserves the old `pkill -o` single-process intent, so the whole-cgroup default
 * (`all`) can never collaterally SIGUSR2-terminate srtla_send (which shares
 * the cgroup while streaming and do NOT handle SIGUSR2).
 *
 * This suite is a static assertion on the shipped rule FILES (the source of truth
 * copied verbatim into the .deb via scripts/build/shared-build-functions.sh), so
 * a future edit that reintroduces the broad `pkill -f` — or drops the main-pid
 * scoping — goes red here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/tests -> src -> backend -> apps -> CeraUI repo root, then deployment/.
const DEPLOYMENT_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"deployment",
);

const AUDIO_RULES = join(DEPLOYMENT_DIR, "98-ceralive-audio.rules");
const USB_RULES = join(DEPLOYMENT_DIR, "99-ceralive-check-usb-devices.rules");

// The exact scoped delivery idiom every RUN+= hotplug signal must now use.
const SCOPED_SIGNAL =
	"/usr/bin/systemctl kill --kill-whom=main --signal=SIGUSR2 ceralive.service";

/** Non-comment, non-blank rule lines (udev comments start with `#`). */
function ruleLines(contents: string): string[] {
	return contents
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Every RUN+= assignment target in the file, unquoted. */
function runTargets(contents: string): string[] {
	const targets: string[] = [];
	const re = /RUN\+="([^"]*)"/g;
	for (const line of ruleLines(contents)) {
		let m: RegExpExecArray | null = re.exec(line);
		while (m !== null) {
			// biome-ignore lint/style/noNonNullAssertion: capture group 1 always present on match
			targets.push(m[1]!);
			m = re.exec(line);
		}
	}
	return targets;
}

describe("udev SIGUSR2 hotplug rules — scoped, avahi-safe delivery", () => {
	const audio = readFileSync(AUDIO_RULES, "utf8");
	const usb = readFileSync(USB_RULES, "utf8");

	it("neither rule uses the broad `pkill -f ceralive` that killed avahi-daemon", () => {
		// Assert against ACTIVE rule lines only — a `#`-comment may legitimately
		// name the retired `pkill -f ceralive` idiom to explain the fix.
		const activeLines = [...ruleLines(audio), ...ruleLines(usb)];
		expect(activeLines.length).toBeGreaterThan(0);
		for (const line of activeLines) {
			// The literal defect: a full-command-line substring match on "ceralive".
			expect(line).not.toMatch(/pkill[^\n]*-f[^\n]*ceralive/);
		}
		// No `pkill` at all remains in either RUN+= target.
		for (const target of [...runTargets(audio), ...runTargets(usb)]) {
			expect(target).not.toContain("pkill");
		}
	});

	it("both rules deliver SIGUSR2 via the unit-scoped systemctl kill idiom", () => {
		expect(runTargets(audio)).toContain(SCOPED_SIGNAL);
		expect(runTargets(usb)).toContain(SCOPED_SIGNAL);
	});

	it("every RUN+= target scopes the signal to the ceralive.service MAIN pid", () => {
		const targets = [...runTargets(audio), ...runTargets(usb)];
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			// Must name the unit explicitly (cgroup scoping) …
			expect(target).toContain("ceralive.service");
			// … and target only the main pid, so a whole-cgroup SIGUSR2 can never
			// terminate srtla_send during a live stream.
			expect(target).toContain("--kill-whom=main");
			expect(target).toContain("--signal=SIGUSR2");
			// udev RUN+= is exec'd without a shell → absolute path is mandatory.
			expect(target.startsWith("/usr/bin/systemctl ")).toBe(true);
		}
	});

	it("audio rule: every signal path converges on the single scoped RUN+= line", () => {
		// All GOTO branches jump to LABEL="signal_ceralive"; the label must be
		// backed by exactly one RUN+= line so no path can reach an unscoped kill.
		const gotoCount = (audio.match(/GOTO="signal_ceralive"/g) ?? []).length;
		expect(gotoCount).toBeGreaterThan(0);
		expect(audio).toContain('LABEL="signal_ceralive"');

		const audioTargets = runTargets(audio);
		expect(audioTargets).toHaveLength(1);
		expect(audioTargets[0]).toBe(SCOPED_SIGNAL);
	});
});
