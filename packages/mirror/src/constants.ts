// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mirror constants (architecture §11).
 *
 * §11 is the single tuning surface for the mirror engine: every magic number the
 * pipeline depends on is named here so it can be reviewed in one place and so a
 * change to one of them is visible in a diff as a change to policy rather than
 * as a stray literal in a loop.
 *
 * The file grew in two steps. WP-M5 (the serializer) declared only the constants
 * that describe the canonical byte format; WP-M3 (config loader + HTTP client)
 * added the transport, sharding and attachment entries, and did so by APPENDING
 * to what was here rather than by restating it. That is the maintenance rule for
 * this module: a new §11 row is added here, never in the module that consumes it.
 *
 * Four of §11's rows are bound rather than declared, and the distinction is
 * load-bearing. `SYS_ID_RE` and `MAX_NAME_BYTES` are owned by
 * `@syncrona/sn-transport` (`mirrorPolicy.ts` and `pathSafety.ts`),
 * `REDACTION_MARKER_PREFIX` is owned by `@syncrona/redaction`, and `RPS_MAX` is
 * sn-transport's `MAX_REQUESTS_PER_SECOND`. Each of those is already the single
 * source of truth for a rule the mirror SHARES with another package — the same
 * regex the transport validates cursors with, the same byte cap the path-safety
 * helpers enforce, the same marker the redactor writes, the same ceiling the two
 * v1 clients rate-limit to. Re-declaring any of them here would produce two
 * literals reviewed in two places, and the first edit to either side would split
 * the format silently. So they are re-exported from their owners below: §11 stays
 * the one place to LOOK them up, without becoming a second place to CHANGE them.
 */

/*
 * Re-exports, not re-declarations — see the note above. These are the only
 * cross-package bindings in this module, and they carry values only: no behaviour
 * from another package is imported into the mirror's constant surface.
 */
export {
  /**
   * INV-6: the only shape a sys_id may have (`/^[0-9a-f]{32}$/`). Owned by
   * `@syncrona/sn-transport` (`mirrorPolicy.ts`), which uses it to reject a
   * keyset cursor that is not a sys_id — a cursor carrying a `^` would smuggle
   * extra conditions past a scope filter. The mirror validates config-supplied
   * sys_ids against the very same object.
   */
  SYS_ID_RE,
  /**
   * D18: 200 UTF-8 bytes per path component. Owned by `@syncrona/sn-transport`
   * (`pathSafety.ts`). ext4 caps a component at 255 *bytes* while APFS caps it
   * at 255 *characters*, so a name that is legal on the machine that wrote it
   * can fail checkout on Linux CI; 200 leaves headroom for the sys_id suffix the
   * uniqueness fallback appends (analyses §9.2).
   */
  MAX_NAME_BYTES,
  /**
   * §11's `RPS_MAX`, bound to sn-transport's `MAX_REQUESTS_PER_SECOND` rather
   * than spelled as a number. The ceiling is a property of a ServiceNow
   * instance, not of the mirror: the core CLI enforces it through
   * axios-rate-limit and the MCP server by spacing requests, and a third,
   * hand-copied `20` in this package would be the one that fails to move when
   * the platform limit does.
   */
  MAX_REQUESTS_PER_SECOND as RPS_MAX,
} from "@syncrona/sn-transport";

export {
  /**
   * `__SYNCRONA_REDACTED__` — the prefix every redaction marker carries. Owned
   * by `@syncrona/redaction`, which mints the markers; the mirror only needs to
   * name the prefix (to grep a tree, to assert a value was replaced rather than
   * dropped). A second copy here would be a second answer to "is this file
   * redacted?".
   */
  REDACTION_MARKER_PREFIX,
} from "@syncrona/redaction";

/**
 * On-disk format version of the mirror working tree (§11, INV-8).
 *
 * INV-8 makes this the contract that protects existing mirrors: any change to
 * the bytes this package emits — key ordering, indentation, which fields are
 * dropped, how an unparseable blob is marked — MUST bump this number and ship a
 * migration, because every downstream mirror would otherwise produce a whole-tree
 * diff on the next run and lose the git history's meaning. Reviewers should treat
 * a golden-fixture change without a bump here as a defect.
 */
export const FORMAT_VERSION = 1;

/**
 * Indentation width for every JSON document the mirror writes (§8).
 *
 * Two spaces, matching the repository's `.editorconfig`/`.prettierrc`, so a
 * `record.json` a human opens in the working tree looks like every other JSON
 * file in the project. The value is shared by the record envelope and by
 * extracted JSON-blob siblings so the two can never drift.
 */
export const JSON_INDENT = 2;

/**
 * Marker prefix for a JSON-blob field the serializer could not canonicalize (§8, F6).
 *
 * The value is stored verbatim behind this prefix instead of being dropped or
 * "fixed": dropping it would be a silent skip (R3), and rewriting it would put
 * bytes in git that the instance never had. The prefix makes the fallback
 * greppable across the whole mirror and unambiguous to a reader, and the field
 * name is additionally reported through `SerializedRecord.parseFailures` so the
 * run report can count it.
 */
export const RAW_MARKER_PREFIX = "raw:";

/**
 * Rows requested per Table API page (§11, `sysparm_limit`).
 *
 * The design document's throughput envelope (design §9.1) was computed at
 * 500-row pages: ~10–20 minutes of API time for a 500k-row instance at the 20 rps
 * ceiling. §11 fixes the mirror at 1000 because the page is the unit of REQUESTS
 * — doubling it halves the round trips against a ceiling the mirror cannot raise
 * — while remaining small enough to be the unit of RETRY and of MEMORY: a page
 * that fails is re-fetched whole, and a page is held entire while it is
 * serialized. A much larger page would trade a bounded, cheap retry for a
 * multi-megabyte one, which is the wrong side of that trade on the flaky links a
 * full sweep runs over.
 */
export const PAGE_SIZE_DEFAULT = 1000;

/**
 * Default sustained request rate for a mirror sweep (§11).
 *
 * Four, not the 20 the platform allows (`RPS_MAX` above). The mirror is a
 * background process that walks an entire instance for minutes at a time, and
 * the instance it walks is usually shared with humans doing interactive work; a
 * sweep that saturates the rate ceiling turns their forms slow for the duration.
 * Four is a fifth of the ceiling, which keeps the sweep inside the design's
 * throughput envelope while leaving the interactive headroom intact. An operator
 * who owns the instance outright can raise it in `mirror.config.js` up to
 * `RPS_MAX`; the loader rejects anything above that rather than clamping
 * silently, because a config that says 50 was written by someone who believed it.
 */
export const RPS_DEFAULT = 4;

/**
 * How far an incremental watermark is rewound before it is used (§11, design §9.2).
 *
 * Five minutes. An incremental fetch asks for `sys_updated_on >= watermark`, and
 * that comparison happens on the INSTANCE's clock while the watermark was
 * recorded against a row the mirror saw at some earlier point — the two clocks
 * are not the same clock, and a record written during the sweep can carry a
 * stamp fractionally behind the watermark the sweep concludes with. Overlapping
 * the window costs nothing (writes into the tree are idempotent upserts, so a
 * record fetched twice produces the same bytes and no commit), while missing a
 * record costs the mirror its completeness claim. Five minutes is generous
 * against realistic NTP skew and still bounded enough that the overlap is a
 * handful of rows rather than a second sweep.
 */
export const WATERMARK_OVERLAP_MS = 300_000;

/**
 * Record count above which a table's shard fans out to 16 hex-prefix shards (§11, D16).
 *
 * Measured, not guessed (analyses §9.4): a 1M-row table kept in a single shard
 * file extrapolates to ~70 MB, which is past GitHub's 50 MB blob warning and
 * approaching its 100 MB hard limit — and a full rewrite of that file on every
 * sync destroys diff locality for a one-record change. 16k is where the
 * benchmark put the knee: below it a single file stays small enough that
 * fanning out only adds directory noise.
 *
 * The choice is STICKY per table (D16): a table that crossed the threshold keeps
 * its fan-out even if it later shrinks, because changing fan-out rewrites every
 * path in that table and is therefore a migration (`mirror migrate`), not a
 * side effect of a sync.
 */
export const SHARD_FANOUT_THRESHOLD_1 = 16_000;

/**
 * Record count above which a table fans out to 256 two-character shards (§11, D16).
 *
 * The same argument applied once more: 16 shards of a 256k-row table are 16k
 * rows each, which is exactly where {@link SHARD_FANOUT_THRESHOLD_1} said a
 * single file stops being comfortable. Keeping the ratio makes the second level
 * a repetition of the first rather than a new rule, and 256 is the natural stop
 * — a third level would multiply directory count faster than it reduces file
 * size, and analyses §9.3 puts vanilla git's comfort zone in the low hundreds of
 * thousands of FILES, which a third level would be spending recklessly.
 */
export const SHARD_FANOUT_THRESHOLD_2 = 256_000;

/**
 * Size at or above which an attachment is stored through git-LFS (§11).
 *
 * 262 144 bytes = 256 KiB, and it applies to BINARY ATTACHMENTS ONLY. The
 * benchmark (analyses §9.3) found LFS to be a net loss below ~1 MB for text,
 * because a pointer file forfeits exactly the delta compression that makes git
 * cheap for text — measured against a 0.7 MB sync delta. Binaries do not delta
 * usefully in the first place, so the trade reverses for them, and M16 measured
 * the shape of the problem on a live instance: 5 755 attachments, 452 of them
 * above this threshold, the largest 76.8 MB. Without LFS those 452 blobs would
 * be committed whole, and the largest of them sits close enough to GitHub's
 * 100 MB hard limit that a slightly bigger one would make the repository
 * unpushable.
 */
export const LFS_THRESHOLD_BYTES = 262_144;
