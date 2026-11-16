import { expect, test } from "bun:test";

test("B15 registry-first imports allow the first network publication", async () => {
	const { setup } = await import("../modules/setup.ts");
	const { identityForIface } = await import(
		"../modules/streaming/link-registry.ts"
	);
	const { processIfconfigOutput } = await import(
		"../modules/network/network-interfaces.ts"
	);
	expect(typeof setup).toBe("object");
	expect(identityForIface("not-present")).toBeUndefined();
	expect(() => processIfconfigOutput("")).not.toThrow();
});
