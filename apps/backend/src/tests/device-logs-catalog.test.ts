/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LOG_SOURCES } from "@ceraui/rpc/schemas";
import { SOURCE_UNITS, sourceOfUnit } from "../modules/device-logs/catalog.ts";
import units from "./fixtures/device-log-sources.json";

const inventory = readFileSync(
	new URL("./fixtures/device-units.txt", import.meta.url),
	"utf8",
)
	.trim()
	.split("\n");

describe("source catalog", () => {
	for (const source of LOG_SOURCES) {
		test(`${source} contains exactly the contracted units`, () => {
			expect(SOURCE_UNITS[source]).toEqual(units[source]);
			for (const unit of units[source]) expect(sourceOfUnit(unit)).toBe(source);
		});
	}

	test.each(inventory)(
		"inventory unit %s belongs to exactly one source",
		(unit) => {
			const owners = LOG_SOURCES.filter((source) =>
				SOURCE_UNITS[source].includes(unit),
			);
			expect([sourceOfUnit(unit)]).toStrictEqual(owners);
		},
	);

	test.each([
		"",
		"unknown.service",
		"ceralive-unknown.service",
		"ceralive",
		"Ceralive.service",
		"ceralive.service\n",
		"--file=/etc/shadow",
		"toString",
		"__proto__",
	])("unknown or malformed unit %j remains unknown", (unit) => {
		expect(sourceOfUnit(unit)).toBeNull();
	});
});
