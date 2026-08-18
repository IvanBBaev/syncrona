// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Public surface of the fake instance (§5.14, WP-M2).
 *
 * A barrel exists so downstream work packages import from one stable path and
 * the internal split (corpus / query / tableState / server) stays free to move.
 * Nothing here is shipped: `packages/mirror/tsconfig.json` compiles `src` alone,
 * so this whole tree is structurally excluded from `dist` rather than excluded
 * by a convention someone could forget.
 */
export {
  BULK_TABLE_NAME,
  BULK_TABLE_ROW_COUNT,
  COMMITTED_CORPUS_DIR,
  CORPUS_FORMAT_VERSION,
  DEFAULT_CORPUS_SEED,
  generateCorpus,
  loadCommittedCorpus,
  loadCorpusFromDirectory,
  renderCorpusFiles,
  resolveWireColumns,
  synthesizeAttachmentBytes,
  wireColumnsByTable,
  writeCorpusFiles,
  type FixtureAttachment,
  type FixtureColumn,
  type FixtureCorpus,
  type FixtureRow,
  type FixtureTable,
} from "./corpus";

export {
  parseEncodedQuery,
  UnsupportedQueryError,
  type OrderByClause,
  type ParsedQuery,
  type QueryCondition,
  type QueryOperator,
} from "./query";

export { TableState, type PageResult } from "./tableState";

export {
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  rateLimitWithoutRetryAfter,
  rateLimitWithRetryAfter,
  type FakeInstanceCredentials,
  type FakeInstanceOptions,
  type FaultRule,
  type MutationScript,
  type ProtocolViolation,
  type RequestRecord,
  type RouteKind,
  type WireRow,
  type WireValue,
} from "./server";

export { fetchJson, fetchRaw, tableUrl, type FakeResponse, type TableApiResult } from "./client";

export { SeededRandom, seedFromString } from "./prng";
