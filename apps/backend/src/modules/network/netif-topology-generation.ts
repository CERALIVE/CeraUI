let generation = 0;

export function getNetifTopologyGeneration(): number {
	return generation;
}

export function advanceNetifTopologyGeneration(): number {
	return ++generation;
}
