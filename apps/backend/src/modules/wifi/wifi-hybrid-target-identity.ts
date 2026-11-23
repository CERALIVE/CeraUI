import { argMatch, ID_RE } from "../../helpers/run.ts";
import { runConcurrentInterface as interfaceRunner } from "./wifi-concurrent-interface-io.ts";
import { interfaceIdentity } from "./wifi-interface-creation.ts";
import {
	radioIdentityReaders,
	sameRadioLifetime,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

/** Observation fences reactivation, but never grants creation or deletion authority. */
export async function readHybridTargetIdentity(
	parent: string,
	target: string,
): Promise<string | undefined> {
	const parentSample = await sampleRadio(
		parent,
		radioIdentityReaders,
		undefined,
	);
	const targetSample = await sampleRadio(
		target,
		radioIdentityReaders,
		undefined,
	);
	const info = await interfaceRunner("iw", [
		"dev",
		argMatch(ID_RE, target),
		"info",
	]).catch(() => "");
	const identity = interfaceIdentity(info);
	const after = await sampleRadio(target, radioIdentityReaders, undefined);
	const incarnation = wifiRadioIdentity.state.rows.get(parent)?.incarnation;
	if (
		!parentSample ||
		!incarnation ||
		!targetSample ||
		!identity ||
		!sameRadioLifetime(after?.lifetime, targetSample.lifetime) ||
		parentSample.lifetime.phyPath !== targetSample.lifetime.phyPath ||
		parentSample.lifetime.wiphy !== targetSample.lifetime.wiphy ||
		Number(identity.ifindex) !== targetSample.lifetime.ifindex ||
		Number(/^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1]) !==
			targetSample.lifetime.wiphy ||
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] !== target
	)
		return undefined;
	return JSON.stringify([
		incarnation,
		parentSample.lifetime,
		targetSample.lifetime,
		identity.wdev,
	]);
}
