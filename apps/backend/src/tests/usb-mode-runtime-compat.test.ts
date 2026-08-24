import { describe, expect, test } from "bun:test";

import {
	type RuntimeCompositionCapability as PackageCapability,
	type RuntimeCompositionResponse as PackageResponse,
	resolveRuntimeCompositionCapability as packageResolver,
} from "@ceralive/modem-control";
import { hasModemControlFunction } from "../modules/modem-control-compat.ts";
import {
	type RuntimeCompositionCapability,
	type RuntimeCompositionResponse,
	resolveRuntimeCompositionCapability,
	resolveRuntimeCompositionCapabilityLocal,
} from "../modules/modems/usb-mode-runtime.ts";

type CeraUiResolver = (
	input: RuntimeCompositionResponse,
) => RuntimeCompositionCapability;
type PackageResolver = (input: PackageResponse) => PackageCapability;

const packageAsCeraUiResolver: CeraUiResolver = packageResolver;
const localAsPackageResolver: PackageResolver =
	resolveRuntimeCompositionCapabilityLocal;

const CASES: readonly RuntimeCompositionResponse[] = [
	{
		vendor: "fibocom",
		currentResponse: "+GTUSBMODE: 1",
		enumerationResponse: "+GTUSBMODE: (0-2)",
	},
	{
		vendor: "quectel",
		currentResponse: '+QCFG: "usbnet",1',
		enumerationResponse: '+QCFG: "usbnet",(0,1)',
	},
	{
		vendor: "simcom",
		currentResponse: "+CUSBPIDSWITCH: 9011",
		enumerationResponse: "+CUSBPIDSWITCH: (9001,9011),(0-1),(0-1)",
	},
	{
		vendor: "sierra",
		currentResponse: "!USBCOMP: 8,1,3,10",
		enumerationResponse: "8: diag,nmea,modem\n9: mbim",
	},
	{
		vendor: "unsupported",
		currentResponse: "",
		enumerationResponse: "",
	},
	{
		vendor: "quectel",
		currentResponse: "malformed",
		enumerationResponse: '+QCFG: "usbnet",(0,1)',
	},
];

describe("USB runtime composition package compatibility", () => {
	test("the exact 1.2.0 package resolver wins the structural seam", () => {
		expect(hasModemControlFunction("resolveRuntimeCompositionCapability")).toBe(
			true,
		);
		expect(resolveRuntimeCompositionCapability).toBe(packageResolver);
		expect(packageAsCeraUiResolver).toBe(packageResolver);
		expect(localAsPackageResolver).toBe(
			resolveRuntimeCompositionCapabilityLocal,
		);
	});

	test("the package and local resolver agree across every vendor and refusal shape", () => {
		for (const input of CASES) {
			expect(packageResolver(input), input.vendor).toEqual(
				resolveRuntimeCompositionCapabilityLocal(input),
			);
		}
	});
});
