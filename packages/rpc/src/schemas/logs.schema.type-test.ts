// Included by the package check as well as the explicit test typecheck.
import type { InferSchemaInput, InferSchemaOutput, ProcedureContract } from '@orpc/contract';
import type { z } from 'zod';
import type { logsContract } from '../contracts/logs.contract';
import type * as logs from './logs.schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Source =
	| 'app'
	| 'engine'
	| 'bonding'
	| 'network'
	| 'cellular'
	| 'updates'
	| 'device'
	| 'kernel';
type Level = 'error' | 'warning' | 'info' | 'debug';
type Failure = {
	ok: false;
	error:
		| 'CURSOR_UNAVAILABLE'
		| 'BOOT_UNAVAILABLE'
		| 'FILTER_CHANGED'
		| 'JOURNAL_UNAVAILABLE'
		| 'BUSY'
		| 'RECORD_TOO_LARGE'
		| 'READ_FAILED'
		| 'INVALID_RETENTION'
		| 'UPDATE_IN_PROGRESS';
};
type Boot = string;
type Filter = { sources: Source[]; levels: Level[]; text?: string | undefined };
type FilterInput = {
	sources?: Source[] | undefined;
	levels?: Level[] | undefined;
	text?: string | undefined;
};
type TimeRange = { since?: number | undefined; until?: number | undefined };
type Query = Filter & TimeRange & { boot: Boot; direction: 'older' | 'newer'; limit: number };
type QueryInput = FilterInput &
	TimeRange & {
		boot?: Boot | undefined;
		direction?: 'older' | 'newer' | undefined;
		limit?: number | undefined;
	};
type Entry = {
	cursor: string;
	ts: number;
	bootId: string;
	level: Level;
	source: Source | null;
	unit: string;
	message: string;
	truncated: boolean;
	marker: 'suppressed' | null;
};
type Page = {
	ok: true;
	entries: Entry[];
	hasMore: boolean | null;
	termination: 'lookahead' | 'end' | 'budget';
	continuation: string | null;
	historyEpoch: number;
	bootId: string | null;
};
type Versions = {
	bootId: string;
	osImage: string | null;
	slot: string | null;
	board: string | null;
	boardModel: string | null;
	ceraui: string;
	engine: string | null;
	senderVersion: string | null;
	kernel: string | null;
	bun: string | null;
};
type BootInfo = {
	bootId: string;
	index: number;
	firstTs: number;
	lastTs: number;
	current: boolean;
	shutdown: 'clean' | 'unclean' | 'unknown' | 'current';
	evidence: string[];
	logsAvailable: boolean;
	versions: Versions | null;
};
type Retention = { maxAgeDays: number | null; maxSizeMb: number | null; detail: 'debug' | 'info' };
type Storage = {
	journalBytes: number | null;
	journalDirBytes: number | null;
	legacyDebugBytes: number;
	ceiling: { maxSizeMb: number; maxAgeDays: number } | null;
	retention: Retention;
	oldestEntryTs: number | null;
	recentVolume: { source: Source | null; entries: number; bytes: number }[];
	recentSample: number;
	eventsBytes: number;
	lastMaintenance: { at: number; ok: boolean; targetMet: boolean } | null;
	lastClearedAt: number | null;
};
type Outputs = {
	logSourceSchema: Source;
	logLevelSchema: Level;
	logErrorCodeSchema: Failure['error'];
	logErrorSchema: Failure;
	logBootSchema: Boot;
	logFilterSchema: Filter;
	logQueryWithoutContinuationSchema: Query;
	logQueryInputSchema: Query & { continuation?: string | undefined };
	logEntrySchema: Entry;
	logQueryPageSchema: Page;
	logQueryOutputSchema: Page | Failure;
	logFollowStartInputSchema: Filter & { afterCursor?: string | undefined };
	logFollowStartOutputSchema:
		| { ok: true; subscriptionId: string; checkpointCursor: string | null }
		| Failure;
	logFollowStopOutputSchema: { success: boolean; checkpointCursor: string | null };
	logFollowMessageSchema: {
		subscriptionId: string;
		entries: Entry[];
		checkpointCursor: string | null;
		dropped: number;
		gap?: 'catchup_exceeded' | 'cursor_unavailable' | 'suppressed' | undefined;
		ended?: 'follower_exit' | 'boot_changed' | 'cleared' | undefined;
	};
	versionContextSchema: Versions;
	logBootInfoSchema: BootInfo;
	logRetentionSchema: Retention;
	logStorageSchema: Storage;
	logStorageOutputSchema: { ok: true; storage: Storage } | Failure;
	logDeleteOlderFilesOutputSchema:
		| { ok: true; storage: Storage; bootsBefore: number; bootsAfter: number }
		| Failure;
	logExportInputSchema: TimeRange & { filter: Filter; boot: Boot };
	logExportOutputSchema: { ok: true; url: string; expiresAt: number } | Failure;
	logAroundInputSchema: { bootId: string; at: number; eventId?: string | undefined };
	logAroundOutputSchema:
		| {
				ok: true;
				anchor: Entry | null;
				approximate: boolean;
				older: Page;
				newer: Page;
				olderQuery: Query;
				newerQuery: Query;
		  }
		| Failure;
	logBundleManifestSchema: {
		sections: (
			| { id: 'versions' | 'events' | 'settings'; entries: number; redactions: number }
			| {
					id: 'journal';
					entries: number;
					redactions: number;
					bootsCovered: number;
					complete: boolean;
			  }
		)[];
		exportedBy: Versions;
		boots: { bootId: string; versions: Versions | null }[];
	};
};
type Inputs = Omit<
	Outputs,
	| 'logFilterSchema'
	| 'logQueryWithoutContinuationSchema'
	| 'logQueryInputSchema'
	| 'logFollowStartInputSchema'
	| 'logExportInputSchema'
	| 'logAroundOutputSchema'
> & {
	logFilterSchema: FilterInput;
	logQueryWithoutContinuationSchema: QueryInput;
	logQueryInputSchema: QueryInput & { continuation?: string | undefined };
	logFollowStartInputSchema: FilterInput & { afterCursor?: string | undefined };
	logExportInputSchema: TimeRange & { filter: FilterInput; boot?: Boot | undefined };
	logAroundOutputSchema:
		| {
				ok: true;
				anchor: Entry | null;
				approximate: boolean;
				older: Page;
				newer: Page;
				olderQuery: QueryInput;
				newerQuery: QueryInput;
		  }
		| Failure;
};
// Flatten intersections before equality so only the public field contract matters.
type Flat<T> = T extends object ? { [K in keyof T]: Flat<T[K]> } : T;
type OutputMatches = {
	[K in keyof Outputs]: Equal<Flat<z.output<(typeof logs)[K]>>, Flat<Outputs[K]>>;
};
type InputMatches = {
	[K in keyof Inputs]: Equal<Flat<z.input<(typeof logs)[K]>>, Flat<Inputs[K]>>;
};
export type LogOutputContracts = Assert<Equal<OutputMatches[keyof Outputs], true>>;
export type LogInputContracts = Assert<Equal<InputMatches[keyof Inputs], true>>;

// These six named assertions specifically guard required output fields after defaults.
export type FilterSourcesRequired = Assert<
	Equal<z.output<typeof logs.logFilterSchema>['sources'], Source[]>
>;
export type FilterLevelsRequired = Assert<
	Equal<z.output<typeof logs.logFilterSchema>['levels'], Level[]>
>;
export type QueryBootRequired = Assert<
	Equal<z.output<typeof logs.logQueryWithoutContinuationSchema>['boot'], string>
>;
export type QueryDirectionRequired = Assert<
	Equal<z.output<typeof logs.logQueryWithoutContinuationSchema>['direction'], 'older' | 'newer'>
>;
export type QueryLimitRequired = Assert<
	Equal<z.output<typeof logs.logQueryWithoutContinuationSchema>['limit'], number>
>;
export type ExportBootRequired = Assert<
	Equal<z.output<typeof logs.logExportInputSchema>['boot'], string>
>;

// Public aliases are a separate boundary: schema-only checks missed A1402.
export type LogSourceAlias = Assert<Equal<logs.LogSource, Source>>;
export type LogLevelAlias = Assert<Equal<logs.LogLevel, Level>>;
export type LogErrorCodeAlias = Assert<Equal<logs.LogErrorCode, Failure['error']>>;
export type LogBootAlias = Assert<Equal<logs.LogBoot, Boot>>;
export type LogFilterAlias = Assert<Equal<Flat<logs.LogFilter>, Flat<FilterInput>>>;
export type LogQueryInputAlias = Assert<
	Equal<Flat<logs.LogQueryInput>, Flat<Inputs['logQueryInputSchema']>>
>;
export type LogEntryAlias = Assert<Equal<logs.LogEntry, Entry>>;
export type LogQueryPageAlias = Assert<Equal<logs.LogQueryPage, Page>>;
export type LogQueryOutputAlias = Assert<Equal<logs.LogQueryOutput, Page | Failure>>;
export type LogFollowStartInputAlias = Assert<
	Equal<Flat<logs.LogFollowStartInput>, Flat<Inputs['logFollowStartInputSchema']>>
>;
export type LogFollowStartOutputAlias = Assert<
	Equal<logs.LogFollowStartOutput, Outputs['logFollowStartOutputSchema']>
>;
export type LogFollowStopOutputAlias = Assert<
	Equal<logs.LogFollowStopOutput, Outputs['logFollowStopOutputSchema']>
>;
export type LogFollowMessageAlias = Assert<
	Equal<logs.LogFollowMessage, Outputs['logFollowMessageSchema']>
>;
export type VersionContextAlias = Assert<Equal<logs.VersionContext, Versions>>;
export type LogBootInfoAlias = Assert<Equal<logs.LogBootInfo, BootInfo>>;
export type LogRetentionAlias = Assert<Equal<logs.LogRetention, Retention>>;
export type LogStorageAlias = Assert<Equal<logs.LogStorage, Storage>>;
export type LogStorageOutputAlias = Assert<
	Equal<logs.LogStorageOutput, Outputs['logStorageOutputSchema']>
>;
export type LogDeleteOlderFilesOutputAlias = Assert<
	Equal<logs.LogDeleteOlderFilesOutput, Outputs['logDeleteOlderFilesOutputSchema']>
>;
export type LogExportInputAlias = Assert<
	Equal<Flat<logs.LogExportInput>, Flat<Inputs['logExportInputSchema']>>
>;
export type LogExportOutputAlias = Assert<
	Equal<logs.LogExportOutput, Outputs['logExportOutputSchema']>
>;
export type LogAroundInputAlias = Assert<
	Equal<logs.LogAroundInput, Inputs['logAroundInputSchema']>
>;
export type LogAroundOutputAlias = Assert<
	Equal<Flat<logs.LogAroundOutput>, Flat<Outputs['logAroundOutputSchema']>>
>;
export type LogBundleManifestAlias = Assert<
	Equal<logs.LogBundleManifest, Outputs['logBundleManifestSchema']>
>;

export const inputAliasExamples = {
	filter: {},
	query: {},
	follow: {},
	retention: { maxAgeDays: null, maxSizeMb: 16, detail: 'debug' },
	export: { filter: {} },
	around: { bootId: '0123456789abcdef0123456789abcdef', at: 0 },
} satisfies {
	filter: logs.LogFilter;
	query: logs.LogQueryInput;
	follow: logs.LogFollowStartInput;
	retention: logs.LogRetention;
	export: logs.LogExportInput;
	around: logs.LogAroundInput;
};

export const wrongInputAliasExamples = {
	// @ts-expect-error Sources are a closed vocabulary.
	filter: { sources: ['unknown'] } satisfies logs.LogFilter,
	// @ts-expect-error Limits are numbers.
	query: { limit: '100' } satisfies logs.LogQueryInput,
	// @ts-expect-error Cursors are strings.
	follow: { afterCursor: 1 } satisfies logs.LogFollowStartInput,
	// @ts-expect-error Retention fields have no defaults.
	retention: {} satisfies logs.LogRetention,
	// @ts-expect-error Export requires its filter even when the filter is empty.
	export: {} satisfies logs.LogExportInput,
	// @ts-expect-error Around requires an anchor time and boot.
	around: {} satisfies logs.LogAroundInput,
};

export const unknownInputAliasExamples = {
	// @ts-expect-error Unknown filter keys are rejected.
	filter: { unknown: true } satisfies logs.LogFilter,
	// @ts-expect-error Unknown query keys are rejected.
	query: { unknown: true } satisfies logs.LogQueryInput,
	// @ts-expect-error Unknown follow keys are rejected.
	follow: { unknown: true } satisfies logs.LogFollowStartInput,
	// @ts-expect-error Unknown retention keys are rejected.
	retention: { ...inputAliasExamples.retention, unknown: true } satisfies logs.LogRetention,
	// @ts-expect-error Unknown export keys are rejected.
	export: { filter: {}, unknown: true } satisfies logs.LogExportInput,
	// @ts-expect-error Unknown around keys are rejected.
	around: { ...inputAliasExamples.around, unknown: true } satisfies logs.LogAroundInput,
};

// @ts-expect-error Parsed filters require the filled defaults.
export const missingFilterDefaults: z.output<typeof logs.logFilterSchema> = {};
// @ts-expect-error Parsed queries require the filled defaults.
export const missingQueryDefaults: z.output<typeof logs.logQueryInputSchema> = {};
// @ts-expect-error Parsed follow requests require the filled filter defaults.
export const missingFollowDefaults: z.output<typeof logs.logFollowStartInputSchema> = {};
// @ts-expect-error Parsed exports require the filled boot and filter defaults.
export const missingExportDefaults: z.output<typeof logs.logExportInputSchema> = { filter: {} };
// @ts-expect-error Response queries carry required defaults, unlike caller queries.
export const missingAroundDefaults: Extract<logs.LogAroundOutput, { ok: true }>['olderQuery'] = {};
// @ts-expect-error Parsed pages carry every entry field.
export const incompletePage: logs.LogQueryPage = {};
// @ts-expect-error Parsed storage responses carry the storage payload.
export const incompleteStorage: logs.LogStorageOutput = { ok: true };

// Pin caller input, handler input, handler output, and caller output separately.
type ProcedureTypes<T> =
	T extends ProcedureContract<infer I, infer O, infer _E>
		? [InferSchemaInput<I>, InferSchemaOutput<I>, InferSchemaInput<O>, InferSchemaOutput<O>]
		: never;
type NoInput = ReturnType<() => void>;
type ProcedureShapes = {
	query: ['logQueryInputSchema', 'logQueryOutputSchema'];
	around: ['logAroundInputSchema', 'logAroundOutputSchema'];
	boots: [NoInput, BootInfo[]];
	followStart: ['logFollowStartInputSchema', 'logFollowStartOutputSchema'];
	followStop: [NoInput, 'logFollowStopOutputSchema'];
	getStorage: [NoInput, 'logStorageSchema'];
	setRetention: ['logRetentionSchema', 'logStorageOutputSchema'];
	deleteOlderFiles: [NoInput, 'logDeleteOlderFilesOutputSchema'];
	deleteLegacyDebug: [NoInput, 'logStorageOutputSchema'];
	clearAll: [NoInput, 'logDeleteOlderFilesOutputSchema'];
	createExport: ['logExportInputSchema', 'logExportOutputSchema'];
	previewBundle: [NoInput, 'logBundleManifestSchema'];
	createBundle: [NoInput, 'logExportOutputSchema'];
};
type ProcedureExpected<S extends ProcedureShapes[keyof ProcedureShapes]> = [
	S[0] extends keyof Inputs ? Inputs[S[0]] : NoInput,
	S[0] extends keyof Outputs ? Outputs[S[0]] : unknown,
	S[1] extends keyof Inputs ? Inputs[S[1]] : S[1],
	S[1] extends keyof Outputs ? Outputs[S[1]] : S[1],
];
type ProcedureMatches = {
	[K in keyof ProcedureShapes]: Equal<
		Flat<ProcedureTypes<(typeof logsContract)[K]>>,
		Flat<ProcedureExpected<ProcedureShapes[K]>>
	>;
};
export type LogProcedureNames = Assert<Equal<keyof typeof logsContract, keyof ProcedureShapes>>;
export type LogProcedureTypes = Assert<Equal<ProcedureMatches[keyof ProcedureShapes], true>>;
