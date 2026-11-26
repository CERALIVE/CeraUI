/**
 * The APN a new gsm profile starts with.
 *
 * Board-measured on a FM350 (NetworkManager 1.52.1, provider database
 * 20250613): with Automatic APN, NetworkManager looked the APN up by the
 * SERVING network. A SIM whose home network is 26221, registered on 26202,
 * got `web.vodafone.de` and every connect was refused. The fixture below keeps
 * the real database's structure and order for the entries involved.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeModemConfigForNetworkManager } from "./modem-nm-config.ts";
import { newProfileConfig } from "./modem-registration.ts";
import { resolveWireConfig } from "./modem-wire-projection.ts";
import {
	deriveApnSource,
	describeHomeApn,
	isImsApn,
	networkManagerPick,
	type ProviderDatabase,
	parseProviderDatabase,
	readProviderDatabase,
	shouldWriteHomeApn,
} from "./provider-apn.ts";

const FIXTURE = `<?xml version="1.0"?>
<serviceproviders format="2.0">
<country code="at">
	<provider>
		<name>Spusu</name>
		<gsm>
			<network-id mcc="232" mnc="17"/>
			<apn value="web">
				<plan type="postpaid"/>
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
</country>
<country code="de">
	<provider>
		<name>T-Mobile (Telekom)</name>
		<gsm>
			<network-id mcc="262" mnc="01"/>
			<apn value="internet.t-d1.de">
				<usage type="internet"/>
				<username>t-mobile</username>
				<password>tm</password>
			</apn>
			<apn value="internet.telekom">
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
	<provider>
		<name>Vodafone</name>
		<gsm>
			<network-id mcc="262" mnc="02"/>
			<apn value="web.vodafone.de">
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
</country>
<country code="us">
	<provider>
		<name>AT&amp;T</name>
		<gsm>
			<network-id mcc="310" mnc="410"/>
			<apn value="NXTGENPHONE">
				<usage type="mms-internet-hipri"/>
			</apn>
		</gsm>
	</provider>
	<provider>
		<name>Verizon</name>
		<gsm>
			<network-id mcc="311" mnc="480"/>
			<apn value="vzwims">
				<usage type="internet"/>
			</apn>
			<apn value="vzwinternet">
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
	<provider>
		<name>Example IMS-first</name>
		<gsm>
			<network-id mcc="999" mnc="01"/>
			<apn value="ims">
				<usage type="internet"/>
			</apn>
			<apn value="data.example">
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
	<provider>
		<name>Example combined usage</name>
		<gsm>
			<network-id mcc="313" mnc="100"/>
			<apn value="">
				<usage type="internet"/>
			</apn>
			<apn value="combined.example">
				<usage type="mms-internet-hipri"/>
			</apn>
		</gsm>
	</provider>
	<provider>
		<name>Straight Talk</name>
		<gsm>
			<network-id mcc="310" mnc="410"/>
			<apn value="att.mvno">
				<usage type="internet"/>
			</apn>
		</gsm>
	</provider>
</country>
</serviceproviders>`;

const db: ProviderDatabase = await parseProviderDatabase(FIXTURE);

describe("parsing the provider database", () => {
	test("keeps file order, networks, credentials and usage", () => {
		expect(db.map((p) => p.name)).toEqual([
			"Spusu",
			"T-Mobile (Telekom)",
			"Vodafone",
			"AT&T",
			"Verizon",
			"Example IMS-first",
			"Example combined usage",
			"Straight Talk",
		]);
		// A blank value is kept for NetworkManager's pick, never written.
		expect(db[6]?.apns.map((a) => a.apn)).toEqual(["", "combined.example"]);
		const telekom = db[1];
		expect(telekom?.networks).toEqual(["26201"]);
		expect(telekom?.apns[0]).toEqual({
			apn: "internet.t-d1.de",
			username: "t-mobile",
			password: "tm",
			usage: ["internet"],
		});
	});
});

describe("NetworkManager's own pick", () => {
	test("is the first exact 'internet' APN of the first listing provider", () => {
		expect(networkManagerPick(db, "26201")?.apn).toBe("internet.t-d1.de");
		expect(networkManagerPick(db, "26202")?.apn).toBe("web.vodafone.de");
		// Verizon's IMS APN comes first with usage "internet".
		expect(networkManagerPick(db, "311480")?.apn).toBe("vzwims");
		// "mms-internet-hipri" is not "internet": NM moves on to the next provider.
		expect(networkManagerPick(db, "310410")?.apn).toBe("att.mvno");
		expect(networkManagerPick(db, "26221")).toBeUndefined();
	});
});

describe("IMS APNs", () => {
	test("are recognised, data APNs are not", () => {
		for (const apn of ["ims", "IMS", "vzwims", "ims.mnc001.mcc262.gprs"]) {
			expect(isImsApn(apn)).toBe(true);
		}
		for (const apn of ["vzwinternet", "internet.telekom", "web", "claims"]) {
			expect(isImsApn(apn)).toBe(false);
		}
	});
});

describe("what the database says about the SIM's own network", () => {
	test("names the home APN, skipping IMS APNs", () => {
		expect(describeHomeApn(db, "26201")).toEqual({
			source: "provider-database",
			homeNetwork: "26201",
			apn: "internet.t-d1.de",
			username: "t-mobile",
			password: "tm",
		});
		expect(describeHomeApn(db, "99901")).toMatchObject({
			apn: "data.example",
		});
	});

	test("falls back to a combined usage only when nothing is marked 'internet'", () => {
		// NetworkManager sends the blank entry (the subscription default).
		expect(networkManagerPick(db, "313100")?.apn).toBe("");
		expect(describeHomeApn(db, "313100")).toMatchObject({
			apn: "combined.example",
		});
	});

	test("says 'not listed' for the measured SIM's home network 26221", () => {
		expect(describeHomeApn(db, "26221")).toEqual({
			source: "not-listed",
			homeNetwork: "26221",
		});
	});

	test("describes 310410 by the same rule as any other network", () => {
		// The carrier's own entry has only a combined usage; NetworkManager and
		// this rule both take the MVNO's exact "internet" entry.
		expect(describeHomeApn(db, "310410")).toMatchObject({
			source: "provider-database",
			apn: "att.mvno",
		});
	});

	test("skips Verizon's IMS-first entry", () => {
		expect(describeHomeApn(db, "311480")).toMatchObject({
			source: "provider-database",
			apn: "vzwinternet",
		});
	});

	test("says nothing without a database or a readable home network", () => {
		expect(describeHomeApn(undefined, "23217")).toBeUndefined();
		expect(describeHomeApn(db, undefined)).toBeUndefined();
		expect(describeHomeApn(db, "")).toBeUndefined();
		expect(describeHomeApn(db, "--")).toBeUndefined();
	});
});

describe("when a new profile gets the home APN written", () => {
	const write = (home: string, serving: string | undefined) =>
		shouldWriteHomeApn(db, describeHomeApn(db, home), serving);

	test("never when Automatic APN would pick the same APN", () => {
		expect(write("26201", "26201")).toBe(false);
		expect(write("310410", "310410")).toBe(false);
		expect(write("26201", undefined)).toBe(false);
		expect(write("26201", "")).toBe(false);
		expect(write("26202", "26202")).toBe(false);
	});

	test("for a SIM registered on another network", () => {
		expect(write("23217", "26202")).toBe(true);
		expect(write("26201", "23217")).toBe(true);
	});

	test("by the network a template pins, when it pins one", () => {
		const hint = describeHomeApn(db, "23217");
		expect(shouldWriteHomeApn(db, hint, "23217", "26202")).toBe(true);
		expect(shouldWriteHomeApn(db, hint, "26202", "23217")).toBe(false);
	});

	test("for Verizon, whose first entry is an IMS APN", () => {
		expect(write("311480", "311480")).toBe(true);
		expect(write("311480", undefined)).toBe(true);
	});

	test("when Automatic APN would pick an IMS APN or nothing", () => {
		expect(write("99901", "99901")).toBe(true);
		expect(write("313100", undefined)).toBe(true);
		expect(write("26201", "99999")).toBe(true);
	});

	test("never without a database APN to write", () => {
		expect(write("26221", "26202")).toBe(false);
		expect(shouldWriteHomeApn(undefined, undefined, "26202")).toBe(false);
	});
});

describe("the profile a new SIM gets", () => {
	test("without a hint, is exactly the previous default", () => {
		const previous = {
			autoconfig: true,
			apn: "internet",
			username: "",
			password: "",
			roaming: true,
			network: "",
		};
		expect(newProfileConfig(undefined, false)).toEqual(previous);
		// A hint alone never changes what NetworkManager is given.
		const { apn_hint: _hint, ...rest } = newProfileConfig(
			describeHomeApn(db, "26201"),
			false,
		);
		expect(rest).toEqual(previous);
	});

	test("with the home APN to write, writes it with Automatic APN off", () => {
		const hint = describeHomeApn(db, "23217");
		const config = newProfileConfig(hint, true);
		expect(config).toMatchObject({
			autoconfig: false,
			apn: "web",
			apn_hint: hint,
		});
		const fields = sanitizeModemConfigForNetworkManager({ ...config });
		expect(fields["gsm.apn"]).toBe("web");
		expect(fields["gsm.auto-config"]).toBe("no");
		expect(Object.keys(fields).some((k) => k.includes("hint"))).toBe(false);
	});

	test("for a SIM the database does not list, keeps Automatic APN", () => {
		const config = newProfileConfig(describeHomeApn(db, "26221"), false);
		expect(config).toMatchObject({ autoconfig: true, apn: "internet" });
		expect(config.apn_hint?.source).toBe("not-listed");
	});
});

describe("the wire's apn_source", () => {
	const hint = describeHomeApn(db, "23217");

	test("describes a profile holding the database APN", () => {
		const config = newProfileConfig(hint, true);
		expect(deriveApnSource(hint, config)).toBe("provider-database");
		expect(resolveWireConfig(config, true).apn_source).toBe(
			"provider-database",
		);
	});

	test("disappears once the APN or Automatic APN changes", () => {
		const config = newProfileConfig(hint, true);
		expect(deriveApnSource(hint, { ...config, apn: "other" })).toBe(undefined);
		expect(deriveApnSource(hint, { ...config, autoconfig: true })).toBe(
			undefined,
		);
	});

	test("'not-listed' shows only while Automatic APN is effective", () => {
		const notListed = newProfileConfig(describeHomeApn(db, "26221"), false);
		expect(resolveWireConfig(notListed, true).apn_source).toBe("not-listed");
		// A device that cannot do Automatic APN never had it on.
		expect("apn_source" in resolveWireConfig(notListed, false)).toBe(false);
	});

	test("is absent without a hint, so the wire is unchanged", () => {
		const wire = resolveWireConfig(newProfileConfig(undefined, false), true);
		expect("apn_source" in wire).toBe(false);
	});
});

describe("loading the installed database", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
	});

	async function fileWith(content: string): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "provider-db-"));
		dirs.push(dir);
		const file = path.join(dir, "serviceproviders.xml");
		await writeFile(file, content);
		return file;
	}

	test("parses a file on disk the same way", async () => {
		expect(await readProviderDatabase(await fileWith(FIXTURE))).toEqual(db);
	});

	test("answers undefined for a missing or damaged file", async () => {
		const file = await fileWith("not xml <");
		expect(await readProviderDatabase(file)).toBeUndefined();
		expect(
			await readProviderDatabase(path.join(path.dirname(file), "absent.xml")),
		).toBeUndefined();
		// And nothing is said from a database that is not there.
		expect(describeHomeApn(undefined, "23217")).toBeUndefined();
	});

	test("rejects a document that is not this database", async () => {
		expect(
			await readProviderDatabase(await fileWith("<other><country/></other>")),
		).toBeUndefined();
	});
});
