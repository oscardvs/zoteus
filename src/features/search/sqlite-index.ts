import { createRequire } from 'node:module';
import type { DatabaseSync as Database, StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SearchIndexBase } from './index-manager.js';
import {
  highDfMinimum,
  MAX_ACCENT_VARIANTS,
  MIN_DERIVATION_PASSAGES,
  pruneTerms,
  REDERIVE_DRIFT,
  type TermPredicate,
} from './query-terms.js';
import { accentKey, normalizeForSearch, tokenize } from './tokenize.js';
import {
  SearchIndexCorruptError,
  SearchIndexUnreadableError,
  isCorruptionError,
  isQuerySyntaxError,
  sidecarsOf,
} from './corruption.js';
import { VectorSalvage } from './vector-salvage.js';
import { DEFAULT_ANN_MIN_CANDIDATES, DEFAULT_ANN_OVERSAMPLE } from './limits.js';
import type {
  BuildCheckpoint,
  ChunkRecord,
  IndexCounts,
  IndexSnapshot,
  RankedId,
  SearchIndexOptions,
} from './backend.js';

/**
 * Required through createRequire rather than imported: `sqlite` is absent from
 * `module.builtinModules` while it is experimental, so bundlers and test runners try to
 * resolve `node:sqlite` from disk and fail. Node itself requires it as the builtin it is.
 * This module is only ever loaded after the factory has confirmed the runtime has it.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Ceiling on a legacy search-index.json this backend will import. Above it the parse is
 * the very wall this backend exists to remove: a 463 MB file needs ~5.4 GB of heap and
 * OOMs stock Node, so the file is left alone and status asks for a rebuild instead (#10).
 */
export const MAX_MIGRATION_BYTES = 200 * 1024 * 1024;

/**
 * Bumped only when the schema below changes shape; a file at any other version is rebuilt,
 * not patched. Enforced in open(): the stamp is read before any DDL or write touches the
 * file, and a database this build does not understand is moved aside, never written into.
 *
 * `vector_codes` is deliberately NOT a bump, and the difference is worth naming. The stamp
 * exists to stop a build from misreading rows it does not understand; that table holds no
 * rows of its own, only a cache derived from the vectors beside it. An older build neither
 * reads nor writes it (every statement it issues names its columns), a newer build creates
 * it on demand and refills it in one pass, and an index that has neither is searched
 * exactly as it was before. Bumping would have sidelined every index in existence and
 * charged its owner a full re-embed (hours, and real API spend) for a cache the server
 * can rebuild from what is already on disk.
 */
const SCHEMA_VERSION = 2;

/**
 * How the keyword index tokenizes, in one place because the migration rung has to declare
 * exactly what `createSchema` declares.
 *
 * `remove_diacritics 0`, not 2, and the difference is a correctness fix rather than a
 * preference. Stripping marks from every token does not normalize spelling in a library
 * that holds more than one language, it merges vocabulary: `án` onto `an`, `bé` onto `be`,
 * two distinct Vietnamese words onto `the`. The recall that stripping bought — typing
 * `theorie` and finding the accented spelling — is kept on the QUERY side instead: an
 * unaccented query term is expanded to the accented variants the vocabulary actually
 * holds (`accent_variants`), so the index itself stores each word exactly once, as
 * written. See tokenize.ts.
 */
const FTS_TOKENIZER = 'unicode61 remove_diacritics 0';

/**
 * Rebuild the folded-form → accented-spelling map from the keyword index's own vocabulary.
 *
 * `fts5vocab` is a virtual table over the existing FTS index — nothing is stored until
 * this SELECT materialises it — and the scan is the only full read: on a 477 512-passage
 * library it visits 639 888 terms in about two seconds, which is why the map is derived
 * state with a home (this table) rather than a query-time computation. Incremental inserts
 * keep it current afterwards (`addRecord`); deletions may leave a variant behind, which
 * costs one zero-hit term in an expanded MATCH and never a wrong result, and the next
 * full build recreates the map from scratch through this same function.
 */
function deriveAccentVariants(db: Database): void {
  db.exec(`
    -- The stamp comes OFF first and goes back on last, so a derivation that dies midway
    -- (this function can run inside a build's own transaction, whose commit would keep
    -- the partial table) leaves no stamp — and an unstamped map is re-derived
    -- unconditionally on the next open, never trusted.
    DELETE FROM meta WHERE key = 'accentVariantsPassages';
    DROP TABLE IF EXISTS accent_variants;
    CREATE TABLE accent_variants (
      folded TEXT NOT NULL,
      term TEXT NOT NULL,
      df INTEGER NOT NULL,
      PRIMARY KEY (folded, term)
    ) WITHOUT ROWID;
    DROP TABLE IF EXISTS temp.accent_vocab;
    CREATE VIRTUAL TABLE temp.accent_vocab USING fts5vocab('main', 'passages_fts', 'row');
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO accent_variants(folded, term, df) VALUES (?, ?, ?)');
  const keys = new Set<string>();
  for (const row of db.prepare('SELECT term, doc FROM temp.accent_vocab').iterate() as Iterable<{
    term: string;
    doc: number;
  }>) {
    const folded = accentKey(row.term);
    if (folded !== row.term && folded.length > 1) {
      insert.run(folded, row.term, row.doc);
      keys.add(folded);
    }
  }
  // The key's own document frequency, stored as a self row (term = folded), because the
  // expansion gate compares the two sides of one question: is this spelling, in THIS
  // corpus, predominantly the accented word? `theorie` (df 214 against 955 accented) is;
  // `trong` (25 771 against 7 027 Vietnamese siblings) is not.
  const selfDf = db.prepare('SELECT doc FROM temp.accent_vocab WHERE term = ?');
  for (const k of keys) {
    const row = selfDf.get(k) as { doc: number } | undefined;
    if (row) insert.run(k, k, row.doc);
  }
  db.exec('DROP TABLE temp.accent_vocab');
  // The refresh stamp: how many passages the map was derived over. Read by
  // `refreshAccentVariants`, so an unchanged library (and an all-ASCII one, whose map is
  // legitimately empty) is not re-scanned on every open.
  const n = (db.prepare('SELECT COUNT(*) AS n FROM passages').get() as { n: number }).n;
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('accentVariantsPassages', String(n));
}

/**
 * One rung of the upgrade ladder: how a database stamped `to - 1` becomes one stamped `to`.
 *
 * The stamp above says what a build must not misread. This says what it can read anyway,
 * and it exists because the two are not the same question. Most schema changes add a
 * column or an index, neither of which invalidates a single stored row — yet without a
 * rung to carry them across, the bump that adds one costs every user in the field a full
 * rebuild, and the expensive half of a rebuild is re-embedding: five and a half hours of
 * local CPU on a 255k-passage library, or real spend on a hosted embedder (#34).
 *
 * The contract for whoever bumps SCHEMA_VERSION next:
 *
 *  - add a rung whose `to` is the new version, or deliberately do not, and understand
 *    that not adding one sidelines every existing index and charges it a re-embed;
 *  - `up` runs inside the transaction that stamps the new version, so a step that throws
 *    leaves the database exactly as it was, at its old stamp. What happens then depends
 *    on why it threw: a corrupt file is sidelined, anything else is refused with the
 *    reason and retried on the next open (see reconcileSchema);
 *  - the ladder must be contiguous. A database is migrated only when every rung from its
 *    stamp to this one exists, because a gap means some version's rows were never
 *    accounted for by anything.
 */
export interface SchemaMigration {
  /** Version this rung produces. It upgrades a database stamped `to - 1`. */
  to: number;
  /** What it changes, in a few words, for the notice a migrated index reports. */
  what: string;
  /** DDL and backfill. Runs inside the transaction that stamps `to`. */
  up(db: Database): void;
}

/**
 * The ladder, in ascending order. The first rung is exactly the case the ladder was built
 * for: the tokenizer changed, so every passage must be tokenized again — and not one
 * vector is touched. Without it the bump would sideline every index in the field and
 * charge it the re-embed the interface comment above prices at five and a half hours of
 * local CPU.
 */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    to: 2,
    what: 'keeps diacritics in the keyword index, answering unaccented queries by expansion',
    up(db) {
      db.exec('DROP TABLE IF EXISTS passages_fts');
      db.exec(`
        CREATE VIRTUAL TABLE passages_fts USING fts5(
          text,
          content='passages',
          content_rowid='pid',
          tokenize='${FTS_TOKENIZER}'
        );
      `);
      const insert = db.prepare('INSERT INTO passages_fts(rowid, text) VALUES (?, ?)');
      // Paged by rowid rather than read whole: the text of a full-text library is hundreds
      // of megabytes, and a migration needing all of it resident is one that fails on the
      // machines least able to afford the rebuild it is there to avoid.
      const page = db.prepare('SELECT pid, text FROM passages WHERE pid > ? ORDER BY pid LIMIT 2000');
      let after = 0;
      for (;;) {
        const rows = page.all(after) as Array<{ pid: number; text: string }>;
        if (!rows.length) break;
        for (const r of rows) insert.run(r.pid, normalizeForSearch(r.text));
        after = rows[rows.length - 1]!.pid;
      }
      deriveAccentVariants(db);
    },
  },
];

/**
 * Passage rowids per rescore statement. The exact stage fetches its candidates by rowid in
 * one `IN (...)` rather than a statement per row: on the measured shape the per-row spelling
 * was about half the cost of the whole two-stage query (#30). Batched rather than one
 * statement of any width so the prepared-statement cache stays two entries deep whatever
 * the candidate count is.
 */
const RESCORE_BATCH = 512;

/**
 * Vectors the corpus mean is averaged over before the sign bits are taken. The mean only
 * has to be close: it recentres the codes so the sign bits carry more information (measured
 * at +2.7 recall points at a quarter width, and Zotero's own semantic search centres the
 * same way, zotero/zotero#6012 `modelCalibration.meanVector`), and every score the search
 * returns comes from the exact rescore afterwards. So it is taken from a strided sample
 * rather than from a second full pass over a corpus this exists to stop reading.
 */
const MEAN_SAMPLE = 20_000;

/**
 * Where that mean lives: base64 of its float32 bytes, beside the width it was taken at.
 * In `meta` rather than in a table of its own because it is one row that is read once per
 * process, and because a build that does not understand these keys leaves them alone.
 */
const CODE_MEAN = 'codeMean';
const CODE_DIM = 'codeDim';

/**
 * How long a statement waits on another connection's lock before giving up. SQLite's
 * default is to fail instantly with "database is locked", which is wrong here: two Zoteus
 * processes legitimately share a data dir whenever a host runs a second, disposable server
 * alongside the real one (Claude Desktop probes that way), and instant failure took BOTH
 * of them down at startup (#18). Ten seconds outlasts any open() and any single build
 * commit, so the loser waits rather than dies.
 */
const BUSY_TIMEOUT_MS = 10_000;

export interface SqliteSearchIndexOptions extends SearchIndexOptions {
  /** Database file (':memory:' is accepted, for tests). */
  path: string;
  /** Legacy JSON artifact to import when this database is created. */
  migrateFrom?: string;
  /** Override for MAX_MIGRATION_BYTES (tests exercise the refusal without a 200 MB fixture). */
  maxMigrationBytes?: number;
  /**
   * Schema stamp this instance writes and upgrades to, with the ladder that gets there.
   * Overridable because SCHEMA_VERSION has never been bumped, so the only way to exercise
   * a bump — the migration, its rollback, and the sideline that catches what cannot
   * migrate — is for a test to play the part of the build that makes one.
   */
  schemaVersion?: number;
  migrations?: SchemaMigration[];
  /** Two-stage vector search; false forces the exact scan (ZOTEUS_INDEX_ANN). */
  annEnabled?: boolean;
  /** Candidates the code stage hands the rescore, per hit asked for (ZOTEUS_INDEX_ANN_OVERSAMPLE). */
  annOversample?: number;
  /** Floor on that candidate set (ZOTEUS_INDEX_ANN_MIN_CANDIDATES). */
  annMinCandidates?: number;
}

/**
 * The binary codes, resident. Built from `vector_codes` on the first semantic query and
 * kept until something writes to the index, because the scan that makes a query fast has to
 * read them all: 3072 sign bits is 384 bytes a passage, so a 255k-passage library costs
 * about 98 MB here, against the ~3.1 GB its float32 vectors would.
 */
interface CodeCache {
  /** Vector width the codes were taken from. A query of another width cannot use them. */
  dim: number;
  /** 32-bit words per code. Codes are padded to a whole number of words. */
  words: number;
  /** Passage rowids, ascending, one per code and parallel to `codes`. */
  pids: Float64Array;
  /** `pids.length × words` mean-centred sign bits, packed little-endian. */
  codes: Uint32Array;
  /** The corpus mean they were centred on; the query is centred by the same one. */
  mean: Float32Array;
  /** Hamming distances, allocated once and rewritten by each query. */
  dists: Uint16Array;
}

interface PassageRow {
  id: string;
  item_key: string;
  title: string;
  text: string;
  source: string | null;
}

/** Statements prepared once at open(): every write in a build goes through them. */
interface Statements {
  insertItem: StatementSync;
  insertPassage: StatementSync;
  insertFts: StatementSync;
  variantsFor: StatementSync;
  deleteFts: StatementSync;
  itemPassages: StatementSync;
  itemFulltext: StatementSync;
  itemOwnWords: StatementSync;
  ownWordsIds: StatementSync;
  deleteOwnWords: StatementSync;
  deletePassages: StatementSync;
  deleteFulltext: StatementSync;
  deleteItemRow: StatementSync;
  itemKeys: StatementSync;
  itemRows: StatementSync;
  itemTitle: StatementSync;
  setVector: StatementSync;
  selectPassage: StatementSync;
  unembedded: StatementSync;
  keyword: StatementSync;
  vectors: StatementSync;
  vectorWidth: StatementSync;
  setMeta: StatementSync;
  getMeta: StatementSync;
  // The two-stage vector path (#30). Everything below reads or maintains `vector_codes`.
  insertCode: StatementSync;
  deleteItemCodes: StatementSync;
  deletePassageCode: StatementSync;
  anyCode: StatementSync;
  allCodes: StatementSync;
  vectorRows: StatementSync;
  vectorByPid: StatementSync;
  uncodedPids: StatementSync;
  sampleVectors: StatementSync;
}

/**
 * SQLite (FTS5) backend. Passages, their vectors and the keyword index live in one file,
 * so the index is bounded by disk rather than by heap: building it costs a few hundred MB
 * of resident memory instead of several GB, reopening it is an open() rather than a parse,
 * and a keyword query touches only the rows it ranks.
 *
 * Requires Node's built-in `node:sqlite` (Node 22.13+), which is why this module is
 * imported dynamically and only after the factory has detected it.
 */
export class SqliteSearchIndex extends SearchIndexBase {
  readonly storage = 'sqlite' as const;
  readonly supportsDelete = true;
  private db: Database | undefined;
  private stmts!: Statements;
  /** True while a write transaction is open; save() is what commits it. */
  private inTransaction = false;
  private c: IndexCounts = {
    documents: 0,
    vectors: 0,
    items: 0,
    fulltextItems: 0,
    fulltextPassages: 0,
    ownWordsItems: 0,
    ownWordsPassages: 0,
  };
  /**
   * Item keys that own full-text passages, so `fulltextItems` stays a distinct count.
   * Bounded by the number of ITEMS (thousands), never by passages: the passages and their
   * vectors are exactly what must not become resident.
   */
  private fulltextKeys = new Set<string>();
  /**
   * The same, for items that hold notes or annotations. Bounded by items for the same
   * reason, and it is what makes `ownWordsItems` a distinct count rather than a query.
   */
  private ownWordsKeys = new Set<string>();
  /** Vector scans performed. A keyword-only query must never cause one (#10). */
  private vectorScans = 0;
  private readonly file: string;
  private readonly migrateFrom: string | undefined;
  private readonly maxMigrationBytes: number;
  private readonly schemaVersion: number;
  private readonly migrations: SchemaMigration[];
  /**
   * Vectors from an index this open had to move aside, kept as a source for the rebuild
   * that follows. Armed only when the sidelined file was written by the same embedder;
   * see VectorSalvage for the rest of the identity a reused vector has to satisfy.
   */
  private salvage: VectorSalvage | undefined;
  /** The sideline's own sentence, so the reuse count can be appended without repeating it. */
  private sidelineNotice: string | undefined;
  private readonly annEnabled: boolean;
  private readonly annOversample: number;
  private readonly annMinCandidates: number;
  /** The resident codes, built on demand and dropped by anything that writes vectors. */
  private codeCache: CodeCache | undefined;
  /**
   * Why the codes cannot serve queries in the state the index is in now. Sticky until a
   * write changes that state, so a corpus the codes cannot cover (two generations of
   * vectors, say) costs one pass to discover rather than one per query.
   */
  private codesUnusable: string | undefined;
  /** Whether the database holds any code at all, so a fresh build skips 255k no-op deletes. */
  private hasCodes = false;
  /**
   * This library's droplist, as derived at the last build, or undefined where the database
   * holds none.
   *
   * The distinction is load-bearing, and it is the reason this is not simply an empty set:
   * undefined means an index written before droplists existed, which must behave exactly as
   * it did then and prune nothing, while an empty set is a real derivation over a corpus no
   * term saturates. Both prune nothing today; only the first is owed an adoption.
   */
  private dropSet: Set<string> | undefined;
  /** The passage count the droplist was derived at, against which drift is measured. */
  private dropSetPassages = 0;
  /** Rescore statements by candidate count; see RESCORE_BATCH. */
  private rescoreStmts = new Map<number, StatementSync>();

  constructor(opts: SqliteSearchIndexOptions) {
    super(opts);
    this.file = opts.path;
    this.migrateFrom = opts.migrateFrom;
    this.maxMigrationBytes = opts.maxMigrationBytes ?? MAX_MIGRATION_BYTES;
    this.schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
    this.migrations = opts.migrations ?? SCHEMA_MIGRATIONS;
    this.annEnabled = opts.annEnabled ?? true;
    this.annOversample = Math.max(1, Math.trunc(opts.annOversample ?? DEFAULT_ANN_OVERSAMPLE));
    this.annMinCandidates = Math.max(1, Math.trunc(opts.annMinCandidates ?? DEFAULT_ANN_MIN_CANDIDATES));
  }

  /** Open (creating it if needed) the database, importing a legacy JSON index once. */
  async open(): Promise<void> {
    if (this.file !== ':memory:') await mkdir(dirname(this.file), { recursive: true });
    // Checked before the handle is created, because creating it creates the file.
    const existed = this.file !== ':memory:' && existsSync(this.file);
    try {
      // Read before write: the stamp of an existing file is examined before any DDL or
      // connection pragma touches it. Doing it the other way around — createSchema first —
      // re-stamped a database written by a newer build and then misread it, destroying the
      // one piece of evidence the stamp exists to carry at exactly the moment it mattered.
      // A migration may leave the handle already open, having earned the right to write.
      if (existed) await this.reconcileSchema();
      if (!this.db) this.openHandle();
      this.createSchema();
      // Derived state does not get to decide whether the index opens, which is the same
      // rule `finalizeVectors` applies to the same scan on the build path. A vocabulary
      // scan that fails for a transient reason — a full disk, a file limit — leaves the
      // map as it was, or empty, and that costs unaccented queries their expansion and
      // nothing else; letting it out of `open()` would reach the factory as an untyped
      // throw, which the factory does not degrade, and take the whole server down over a
      // cache one scan rebuilds. Corruption is deliberately not caught here: that is
      // evidence about the file, and the catch below is what turns it into a sideline.
      try {
        this.refreshAccentVariants();
      } catch (e) {
        if (isCorruptionError(e)) throw e;
        this.opts.logger?.warn(`accent variants not refreshed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.prepareStatements();
      // `existed` deliberately still gates the import after a sideline: the legacy JSON
      // was already consumed by whichever build wrote the incompatible database, and
      // re-importing it here would resurrect stale data next to the moved-aside truth.
      if (!existed && this.migrateFrom) await this.importJson(this.migrateFrom);
      this.refreshCounts();
      this.loadMeta();
      this.syncSalvage();
    } catch (e) {
      if (!isCorruptionError(e) && !(e instanceof SearchIndexCorruptError)) throw e;
      // The handle may exist, so this object owns it and must release it before handing
      // the failure on. Not housekeeping: the message names three files for the user to
      // delete, and on Windows an open handle refuses the delete — a server holding them
      // would block the recovery it is prescribing.
      await this.close().catch(() => {});
      throw e instanceof SearchIndexCorruptError ? e : new SearchIndexCorruptError(this.file, e);
    }
  }

  /**
   * Derive the expansion map once for a database that predates it or lost it.
   *
   * `accent_variants` is derived state, so it is recoverable by construction: a schema-2
   * database whose map is absent (created by a build that never derived, or deleted by
   * hand) is healed here with one vocabulary scan — about two seconds on a 477 512-passage
   * library — instead of being wrong quietly. The meta stamp keeps the scan from running
   * on every open of a library whose map is legitimately empty.
   */
  private refreshAccentVariants(): void {
    const row = this.handle
      .prepare("SELECT value FROM meta WHERE key = 'accentVariantsPassages'")
      .get() as { value?: string } | undefined;
    const current = (this.handle.prepare('SELECT COUNT(*) AS n FROM passages').get() as { n: number }).n;
    if (row?.value !== undefined) {
      const stored = Number(row.value);
      // The droplist cadence (see the derived-state note on deriveAccentVariants): a
      // handful of new items cannot move which spelling dominates, so rescan only when
      // the passage count has drifted by more than ~10% since the map was derived.
      if (Math.abs(current - stored) <= 0.1 * Math.max(stored, 1)) return;
    }
    deriveAccentVariants(this.handle);
  }

  /** Create the writable handle and apply its connection pragmas, after the schema probe. */
  private openHandle(): void {
    this.db = new DatabaseSync(this.file);
    // Before anything that takes a lock, so every statement below inherits the wait.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL rather than the rollback journal: a build commits every few hundred items, and
    // WAL makes those commits cheap while still leaving a complete database behind a
    // crash (an interrupted build rolls back to its last commit, never a torn file).
    // Switching modes needs an exclusive lock that a second process can hold for as long
    // as it is connected, past any busy timeout — but the mode is a property of the file,
    // so that process has already set it and this one just inherits it. Failing to set a
    // mode the database is in is not worth refusing to open over.
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch (err) {
      if (isCorruptionError(err)) throw err;
      this.opts.logger?.debug(`Could not set journal_mode=WAL on ${this.file}: ${String(err)}`);
    }
    // NORMAL fsyncs at checkpoints instead of on every commit. A power cut can then cost
    // the last commits of a running build, which the next build replaces anyway, but it
    // can never cost the database itself.
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  /**
   * What an existing database says it is, read without writing anything.
   *
   * 'fresh' — no tables at all (a zero-byte file from a handle opened and dropped, which
   * SQLite treats as a valid empty database): safe to create the schema in.
   * 'unstamped' — tables exist but no readable integer stamp: an interrupted first
   * creation, or a file some other program put at this path. Not ours to write into.
   * Otherwise the integer the file is stamped with.
   */
  private storedSchemaVersion(db: Database): number | 'fresh' | 'unstamped' {
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view')")
      .get() as { n: number };
    if (tables.n === 0) return 'fresh';
    // Inspect rather than catching SELECT failures: a missing or foreign-shaped meta
    // table means "unstamped", but a lock, I/O failure or interruption must propagate.
    // Treating every non-corruption error as an absent stamp could move a healthy database
    // merely because another legitimate Zoteus process held it for longer than the wait.
    const metaColumns = db.prepare('PRAGMA table_info(meta)').all() as Array<{ name: string }>;
    const names = new Set(metaColumns.map((column) => column.name));
    if (!names.has('key') || !names.has('value')) return 'unstamped';
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    const value = row?.value;
    if (value === undefined) return 'unstamped';
    const version = Number(value);
    return Number.isInteger(version) ? version : 'unstamped';
  }

  /**
   * What an existing database holds, for the sentence a sideline owes its owner.
   *
   * Read from the same read-only probe as the stamp, because it answers the question the
   * old notice left the user to discover by watching: what a rebuild is going to cost.
   * The counts are what must be re-indexed and the embedder id is what says whether the
   * expensive half — re-embedding — can be avoided by reusing the vectors already here.
   */
  private probeContents(db: Database): { passages: number; vectors: number; embedderId?: string } {
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS p, COUNT(vector) AS v FROM passages')
        .get() as { p: number; v: number };
      const id = db.prepare("SELECT value FROM meta WHERE key = 'embedderId'").get() as
        | { value?: string }
        | undefined;
      return { passages: Number(row?.p ?? 0), vectors: Number(row?.v ?? 0), ...(id?.value ? { embedderId: id.value } : {}) };
    } catch {
      // A file whose shape this build cannot read is exactly the file being moved aside;
      // it owes no census, and failing the open over one would be absurd.
      return { passages: 0, vectors: 0 };
    }
  }

  /**
   * Decide what an existing database is to this build — current, upgradable, or foreign —
   * and act on it, leaving either a migrated file (handle open) or a moved-aside one.
   *
   * The read-only probe comes first and stays genuinely read-only: journal_mode=WAL can
   * rewrite bytes in the database header, so even the normal writable connection pragmas
   * must wait until the stamp has been accepted. What is new is that "accepted" now has
   * two forms. A database at an OLDER version of this schema is ours, we know exactly what
   * it holds, and a ladder of migrations exists to bring it forward without re-reading a
   * single item from Zotero (#34). Only a version nothing on the ladder reaches — a newer
   * build's, an unstamped file, a gap in the ladder — is still moved aside.
   */
  private async reconcileSchema(): Promise<void> {
    const probe = new DatabaseSync(this.file, { readOnly: true });
    let stored: number | 'fresh' | 'unstamped';
    let contents: { passages: number; vectors: number; embedderId?: string };
    try {
      probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      stored = this.storedSchemaVersion(probe);
      contents = stored === 'fresh' || stored === this.schemaVersion ? { passages: 0, vectors: 0 } : this.probeContents(probe);
    } finally {
      probe.close();
    }
    if (stored === 'fresh' || stored === this.schemaVersion) return;
    const ladder = typeof stored === 'number' ? this.migrationPath(stored) : undefined;
    if (ladder) {
      const failure = this.runMigrations(stored as number, ladder);
      if (failure === undefined) return;
      // A migration that threw rolled itself back, so the file is untouched at its old
      // stamp. What happens next depends on WHY it threw, and the two answers must not
      // be merged: a corrupt database is evidence to move aside, but a transient error —
      // a full disk, a file-size limit, a lock — is a proven-intact database that failed
      // to upgrade TODAY. Sidelining it would discard a complete index (and start an
      // empty one) over a condition a retry can clear; `isCorruptionError` exists for
      // exactly this distinction, so it is consulted here.
      if (isCorruptionError(failure)) {
        await this.sideline(stored, contents, failure instanceof Error ? failure.message : String(failure));
        return;
      }
      // Not corruption: leave the file at its old stamp and surface the failure. The
      // factory degrades this into "search refuses, and says why" — the server survives,
      // nothing is written over the file, and the next open retries the ladder against an
      // untouched database.
      const reason = failure instanceof Error ? failure.message : String(failure);
      // The class's stock message ends in rebuild advice, and for THIS refusal that
      // advice is exactly wrong: a rebuild deletes an intact, fully-vectorized database
      // to cure a transient condition a restart cures for free. Say the right thing
      // instead — the refusal is the whole value of this path.
      //
      // And say it in the machinery as well as in the sentence, with an empty file list.
      // `repairSearchIndex` deletes precisely the files a fault names, on an explicit
      // `action:"build"` — which is the very call someone makes after reading that search
      // is unavailable. Naming the database here would have unlinked an intact index over
      // a full disk, sidelining by another road and without even the sideline's copy. A
      // fault naming nothing is refused by the repair, which then repeats this message.
      throw new SearchIndexUnreadableError(
        this.file,
        new Error(
          `it is intact at schema version ${stored} but could not be upgraded to ${this.schemaVersion} (${reason})`,
        ),
        {
          files: [],
          message:
            `The search index at ${this.file} is intact at schema version ${stored} but could not be ` +
            `upgraded to ${this.schemaVersion}: ${reason}. ` +
            'The file was left untouched and nothing will be written over it. Search is unavailable until the ' +
            'upgrade succeeds; every other tool still works. Fix the underlying condition (a full disk, a file ' +
            'limit, another process holding the database) and restart the server — the upgrade then completes ' +
            'in place, with nothing re-read from Zotero and no vectors re-computed. A rebuild is NOT needed ' +
            'and would discard a usable index.',
        },
      );
    }
    await this.sideline(stored, contents);
  }

  /**
   * The contiguous run of rungs from `stored` up to this build's version, or undefined
   * when there is no complete one. Contiguity is the whole check: a missing rung means
   * some version's rows were never accounted for, and stepping over it would hand this
   * build rows nothing ever claimed to understand.
   */
  private migrationPath(stored: number): SchemaMigration[] | undefined {
    // Only forwards. A database from a NEWER build may hold columns and rows this one
    // cannot read at all, and no downgrade step exists to consult about them.
    if (stored >= this.schemaVersion || stored < 0) return undefined;
    const steps: SchemaMigration[] = [];
    for (let v = stored + 1; v <= this.schemaVersion; v++) {
      const step = this.migrations.find((m) => m.to === v);
      if (!step) return undefined;
      steps.push(step);
    }
    return steps;
  }

  /**
   * Run the ladder, and stamp the new version in the same transaction. Returns undefined
   * on success, or the error itself — the CAUSE, not its message, because the caller has
   * to ask `isCorruptionError` of it before deciding between sideline and refusal.
   *
   * One transaction over every rung, and the stamp inside it: a database is either fully
   * at the new version or still fully at the old one, never at some half-applied state
   * between two that no build has a schema for. The handle is opened here (and kept, so
   * open() does not open a second one) because migrating IS writing, and the ordering
   * rule the probe protects is "do not write into a database this build does not
   * understand" — a rung that exists is this build saying it understands this one.
   */
  private runMigrations(stored: number, steps: SchemaMigration[]): unknown {
    this.openHandle();
    const db = this.handle;
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const step of steps) step.up(db);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schemaVersion',
        String(this.schemaVersion),
      );
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Nothing to roll back (the BEGIN itself failed), which is the same outcome.
      }
      // Released before the sideline that follows: on Windows an open handle refuses the
      // rename, and this object must not block the recovery it is about to prescribe.
      // Closed raw rather than through close(), which would flush through statements this
      // failure means were never prepared.
      this.db?.close();
      this.db = undefined;
      // `?? new Error(...)`: a thrown nullish value must not read as the success return.
      return e ?? new Error('migration failed with a nullish throw');
    }
    const what = steps.map((s) => s.what).join('; ');
    this.storeNotice =
      `The search index at ${this.file} was upgraded in place from schema version ${stored} to ` +
      // "Nothing was re-indexed" used to be part of this sentence. It was true while the
      // ladder was empty; it is not a property of the mechanism, and the first real rung
      // re-indexes every passage. What the ladder does guarantee is the expensive half —
      // a rung runs inside the stamping transaction and nothing in it embeds — so that is
      // what the notice claims, and the rung's own `what` says the rest.
      `${this.schemaVersion} (${what}). No vectors were re-computed.`;
    this.opts.logger?.info(this.storeNotice);
    return undefined;
  }

  /**
   * Move a database this build must not write into out of the way, and open fresh.
   *
   * Sideline, never delete: the moved file is a complete database, evidence of the skew
   * and readable by whichever build stamped it. Sidecars travel with it — a fresh database
   * created beside an orphaned `-wal` is the one arrangement that can manufacture a
   * corruption out of this protection, because SQLite would replay a log belonging to a
   * file that no longer exists — and in sidecarsOf order, database last, so an interruption
   * mid-move can only strand sidecars beside the moved file, never beside the fresh one.
   * One notice, on the channel status already reports storage decisions on.
   *
   * The moved file is also, from here on, a vector source. Its embeddings were computed
   * from text and a model, neither of which a schema change touches, so every passage the
   * rebuild re-reads unchanged can take its vector from here instead of paying for it a
   * second time (#34). Armed only when the same embedder wrote it, and only then does the
   * notice promise it.
   */
  private async sideline(
    stored: number | 'unstamped',
    contents: { passages: number; vectors: number; embedderId?: string },
    migrationFailure?: string,
  ): Promise<void> {
    const dest = `${this.file}.incompatible-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      for (const src of sidecarsOf(this.file)) {
        const target = src === this.file ? dest : `${dest}${src.slice(this.file.length)}`;
        await rename(src, target).catch((e: NodeJS.ErrnoException) => {
          if (e?.code !== 'ENOENT') throw e;
        });
      }
    } catch (e) {
      // The file is readable — its stamp just said so — but it can neither be written into
      // nor moved aside. That is exactly the state CorruptSearchIndex exists to hold: the
      // server survives, search refuses naming this file, and an explicit
      // `zotero_index action:"build"` may clear it, with the consent that implies (#21).
      throw new SearchIndexCorruptError(this.file, e);
    }
    const said =
      stored === 'unstamped'
        ? 'carries tables but no schema stamp — an interrupted creation, or not a Zoteus index at all'
        : `is stamped schema version ${stored}, which this build does not understand` +
          (migrationFailure ? ` and could not be upgraded (${migrationFailure})` : '');
    this.storeNotice =
      `The search index at ${this.file} ${said}. ` +
      `It was moved aside to ${dest} (nothing was deleted) and a fresh index was created; ` +
      `rebuild it with zotero_index action:"build".` +
      this.priceOf(dest, contents);
    this.sidelineNotice = this.storeNotice;
    this.opts.logger?.warn(this.storeNotice);
  }

  /**
   * What the rebuild a sideline just prescribed is going to cost, and how much of it the
   * moved-aside file can pay.
   *
   * The old notice said an index had been moved and a rebuild was needed, and stopped
   * there — leaving the one number that matters (five hours of local embedding on a large
   * library, or a hosted provider's bill) to be discovered by watching a progress line
   * (#34). Re-embedding is the expensive half, so this says how many passages it covers,
   * and whether they have to be paid for at all: the salvage is armed here, and only when
   * it is does the sentence promise anything.
   */
  private priceOf(dest: string, contents: { passages: number; vectors: number; embedderId?: string }): string {
    if (contents.passages === 0) return '';
    const scale = ` That rebuild re-indexes ${contents.passages} passage(s)`;
    if (contents.vectors === 0) {
      return `${scale}, none of which carried vectors, so it costs a crawl of the library and no embedding.`;
    }
    const embedder = contents.embedderId ?? 'an unrecorded embedder';
    if (!contents.embedderId || contents.embedderId !== this.embedderId) {
      return (
        `${scale} and re-computes ${contents.vectors} vector(s), which is the expensive half: the moved-aside ` +
        `index was embedded by ${embedder} and this server embeds with ${this.embedderId ?? 'no embedder'}, so ` +
        'its vectors cannot be reused. Budget for a full re-embed.'
      );
    }
    this.salvage = VectorSalvage.openIfUsable(dest, this.opts.logger);
    if (!this.salvage) {
      return (
        `${scale} and re-computes ${contents.vectors} vector(s): the moved-aside index was embedded by the same ` +
        'provider, but its vectors could not be opened for reuse. Budget for a full re-embed.'
      );
    }
    return (
      `${scale}, but not their vectors: ${contents.vectors} of them were embedded by ${embedder}, which is what ` +
      'this server still uses, so every passage whose text is unchanged takes its vector from the moved-aside ' +
      'index instead of being embedded again. Only genuinely new or edited text costs embedding time.'
    );
  }

  /**
   * Carry the salvage across process lifetimes, in both directions.
   *
   * The rebuild a sideline prescribes is not usually run by the process that prescribed
   * it: the notice reaches a user through `zotero_index action:"status"`, and by the time
   * they act the server may well have restarted. An in-process-only salvage would then
   * have quietly expired between the sentence promising reuse and the rebuild that needed
   * it — the worst version of this, because the promise was made in writing.
   *
   * So the sideline's destination is recorded in the fresh index's own meta table, and a
   * later open re-arms from it. Two rules keep the pointer honest: it is only followed
   * while the embedder is still the one that wrote those vectors, and a pointer that no
   * longer resolves (the user deleted the moved-aside file, as they were told they may)
   * is cleared rather than retried on every open.
   */
  private syncSalvage(): void {
    if (this.salvage) {
      this.storeSalvagePointer(this.salvage.path, this.embedderId);
      return;
    }
    const from = this.meta('salvageFrom');
    if (!from) return;
    // Kept, not cleared, when the embedder differs: switching ZOTEUS_EMBEDDING_MODEL back
    // makes those vectors usable again, and nothing about the file has changed meanwhile.
    if ((this.meta('salvageEmbedderId') || undefined) !== this.embedderId) return;
    this.salvage = VectorSalvage.openIfUsable(from, this.opts.logger);
    if (!this.salvage) this.storeSalvagePointer(undefined, undefined);
    // A stamped index re-arming a pointer to another library's file can be answered here,
    // before a single passage is looked up. The pointer itself is kept, on the same
    // reasoning as the embedder above: it is not a wrong pointer, this is just not the
    // library that wrote those vectors.
    this.dropForeignSalvage();
  }

  /**
   * Disarm a salvage whose vectors belong to a different library than the one being
   * indexed, and say once why (#44).
   *
   * Not decidable where the salvage is armed: `sideline()` runs at open, before any build
   * has said which library it is crawling, so the file is opened first and judged as soon
   * as there is something to judge it against. Refusing costs the re-embed the rebuild
   * would have paid anyway, and everything else about the sideline is unchanged: the
   * moved-aside file is still there, still complete, still named in the notice.
   */
  private dropForeignSalvage(): void {
    const refusal = this.salvage?.refusalFor(this.library);
    if (!refusal) return;
    this.opts.logger?.info(refusal);
    this.salvage?.close();
    this.salvage = undefined;
  }

  /**
   * Write (or clear) the pointer. Outside the build's transaction deliberately: it is one
   * fact about where this index came from, and it has to be durable the moment the
   * sideline happens rather than whenever the next build commits.
   */
  private storeSalvagePointer(path: string | undefined, embedderId: string | undefined): void {
    try {
      this.stmts.setMeta.run('salvageFrom', path ?? '');
      this.stmts.setMeta.run('salvageEmbedderId', embedderId ?? '');
    } catch (e) {
      // A pointer that could not be stored costs a re-embed if the server restarts before
      // the rebuild, which is the outcome that existed before it. Not worth an open().
      this.opts.logger?.debug(`Could not record the vector salvage pointer: ${String(e)}`);
    }
  }

  /**
   * Take a passage's vector from the sidelined index rather than embedding it, when that
   * file holds one for this exact id and this exact text. See VectorSalvage.
   */
  protected adoptVector(rec: ChunkRecord): boolean {
    if (!this.salvage) return false;
    // The library check lands here rather than at the arming site because this is the
    // first moment it can: by the time a passage is offered, the build has stamped the
    // library it is crawling. One mismatch disarms the salvage, so this costs a null
    // check per passage thereafter.
    this.dropForeignSalvage();
    if (!this.salvage) return false;
    const blob = this.salvage.vectorFor(rec.id, rec.text);
    if (!blob) return false;
    this.begin();
    // The same write putVector makes, minus the float round-trip: the blob is already in
    // the storage encoding, and decoding it to re-encode it byte-for-byte would only be a
    // way to introduce a difference. The code bookkeeping is identical, because what makes
    // a code stale is the vector changing, not where the vector came from.
    if (Number(this.stmts.setVector.run(blob, rec.id).changes) > 0) this.c.vectors++;
    if (this.hasCodes) this.stmts.deletePassageCode.run(rec.id);
    this.invalidateCodes();
    return true;
  }

  /** Vectors this open reused from a sidelined index instead of re-embedding them. */
  get salvagedVectors(): number {
    return this.salvage?.reused ?? 0;
  }

  /**
   * Record damage discovered mid-flight and return the error to raise for it.
   *
   * Until this existed, a healthy-looking index that met corruption during a query threw
   * the right sentence and remembered nothing: its status stayed clean and the next call
   * went straight back to the same broken file. Recording it makes the refusal stick, and
   * is what lets `zotero_index action:"build"` see that there is something to repair.
   */
  private noteCorruption(cause: unknown): SearchIndexCorruptError {
    const fault = cause instanceof SearchIndexCorruptError ? cause : new SearchIndexCorruptError(this.file, cause);
    this.noteStoreFault(fault);
    return fault;
  }

  private get handle(): Database {
    if (!this.db) throw new Error('The SQLite search index is not open.');
    return this.db;
  }

  private createSchema(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passages (
        pid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT,
        vector BLOB
      );
      CREATE INDEX IF NOT EXISTS passages_item ON passages(item_key);
      CREATE INDEX IF NOT EXISTS passages_source ON passages(source);
      -- One binary code per vector: its sign bits after the corpus mean is subtracted,
      -- packed 8 dimensions to a byte. Kept in its own table rather than in a column of
      -- passages for one reason: a column would sit behind the 12 KB vector in the row,
      -- so reading every code would mean reading every vector's overflow pages too, which
      -- is the 3.1 GB this table exists to stop reading. Alone in a table, the codes are
      -- 98 MB read sequentially. Derived from passages.vector and rebuilt from it, so
      -- losing this table costs a pass, never data.
      CREATE TABLE IF NOT EXISTS vector_codes (pid INTEGER PRIMARY KEY, code BLOB NOT NULL);
      -- External content: the passage text is stored once, in the passages table, and the
      -- index points back at it by rowid. remove_diacritics 0 keeps accents: "Brontë" is
      -- indexed as written, and an unaccented query reaches it through accent_variants
      -- below, never by folding the index. See FTS_TOKENIZER.
      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
        text,
        content='passages',
        content_rowid='pid',
        tokenize='${FTS_TOKENIZER}'
      );
      -- The folded-form → accented-spelling map queries expand through: derived from the
      -- FTS vocabulary (deriveAccentVariants), refreshed on the droplist cadence by
      -- refreshAccentVariants. Derived state: losing this table costs one vocabulary
      -- scan, never data. df is the spelling's document frequency at derivation time —
      -- the expansion gate's evidence.
      CREATE TABLE IF NOT EXISTS accent_variants (
        folded TEXT NOT NULL,
        term TEXT NOT NULL,
        df INTEGER NOT NULL,
        PRIMARY KEY (folded, term)
      ) WITHOUT ROWID;
    `);
    this.handle
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run('schemaVersion', String(this.schemaVersion));
  }

  private prepareStatements(): void {
    const db = this.handle;
    // Rescore statements are prepared on demand against this handle, so none may outlive it.
    this.rescoreStmts.clear();
    this.stmts = {
      insertItem: db.prepare('INSERT OR IGNORE INTO items(item_key, title) VALUES (?, ?)'),
      insertPassage: db.prepare(
        'INSERT INTO passages(id, item_key, title, text, source) VALUES (?, ?, ?, ?, ?)',
      ),
      insertFts: db.prepare('INSERT INTO passages_fts(rowid, text) VALUES (?, ?)'),
      variantsFor: db.prepare('SELECT term, df FROM accent_variants WHERE folded = ?'),
      // The external-content delete protocol: FTS5 stores no text of its own, so a row is
      // retired by handing back the exact rowid and text that were indexed. A bare DELETE
      // on `passages` would leave the index pointing at a rowid that no longer resolves,
      // and the next query over those terms fails or returns a stale hit.
      deleteFts: db.prepare("INSERT INTO passages_fts(passages_fts, rowid, text) VALUES('delete', ?, ?)"),
      itemPassages: db.prepare(
        'SELECT pid, text, source, vector IS NOT NULL AS has_vector FROM passages WHERE item_key = ?',
      ),
      itemFulltext: db.prepare(
        "SELECT pid, text, vector IS NOT NULL AS has_vector FROM passages WHERE item_key = ? AND source = 'fulltext'",
      ),
      // Both own-words statements go through `passages_source`, so they read the notes and
      // annotations alone and never the body passages they sit beside — which on a
      // full-text index is the difference between thousands of rows and hundreds of
      // thousands.
      itemOwnWords: db.prepare(
        "SELECT pid, text, vector IS NOT NULL AS has_vector FROM passages WHERE item_key = ? AND source IN ('note', 'annotation')",
      ),
      ownWordsIds: db.prepare("SELECT id FROM passages WHERE source IN ('note', 'annotation')"),
      deleteOwnWords: db.prepare("DELETE FROM passages WHERE item_key = ? AND source IN ('note', 'annotation')"),
      deletePassages: db.prepare('DELETE FROM passages WHERE item_key = ?'),
      deleteFulltext: db.prepare("DELETE FROM passages WHERE item_key = ? AND source = 'fulltext'"),
      deleteItemRow: db.prepare('DELETE FROM items WHERE item_key = ?'),
      itemKeys: db.prepare('SELECT item_key AS k FROM items'),
      // Ordered by rowid, which is insertion order, so a resumed build's full-text worklist
      // is in the order the interrupted crawl indexed them rather than in key order.
      itemRows: db.prepare('SELECT item_key AS k, title AS t FROM items ORDER BY rowid'),
      itemTitle: db.prepare('SELECT title AS t FROM items WHERE item_key = ?'),
      setVector: db.prepare('UPDATE passages SET vector = ? WHERE id = ?'),
      selectPassage: db.prepare('SELECT id, item_key, title, text, source FROM passages WHERE id = ?'),
      // Unindexed on purpose: on a healthy index it stops at the first row and on a
      // half-embedded one every scanned row is a row it wants, so an index on a column
      // that is NULL for a moment during one build would cost every build to maintain.
      unembedded: db.prepare(
        'SELECT id, item_key, title, text, source FROM passages WHERE vector IS NULL ORDER BY pid LIMIT ?',
      ),
      // Deliberately never selects `vector`: a keyword query must not pull vectors into JS.
      keyword: db.prepare(`
        SELECT p.id AS id, bm25(passages_fts) AS rank
        FROM passages_fts JOIN passages p ON p.pid = passages_fts.rowid
        WHERE passages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      vectors: db.prepare('SELECT id, vector FROM passages WHERE vector IS NOT NULL'),
      vectorWidth: db.prepare('SELECT length(vector) AS bytes FROM passages WHERE vector IS NOT NULL LIMIT 1'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      insertCode: db.prepare('INSERT OR REPLACE INTO vector_codes(pid, code) VALUES (?, ?)'),
      // Codes are keyed by rowid, and SQLite hands a deleted row's rowid to the next
      // insert once it is the largest one free. So a code MUST leave with the passage it
      // was taken from: left behind, it would eventually describe a different passage.
      deleteItemCodes: db.prepare('DELETE FROM vector_codes WHERE pid IN (SELECT pid FROM passages WHERE item_key = ?)'),
      deletePassageCode: db.prepare('DELETE FROM vector_codes WHERE pid = (SELECT pid FROM passages WHERE id = ?)'),
      anyCode: db.prepare('SELECT 1 AS present FROM vector_codes LIMIT 1'),
      allCodes: db.prepare('SELECT pid, code FROM vector_codes ORDER BY pid'),
      vectorRows: db.prepare('SELECT pid, vector FROM passages WHERE vector IS NOT NULL'),
      vectorByPid: db.prepare('SELECT vector FROM passages WHERE pid = ?'),
      // The rows an update appended since the codes were last built. The join is answered
      // from the row headers of `passages` (whether `vector` is NULL is in the header) and
      // a rowid probe into the small codes table, so it does not read the vectors of the
      // rows it skips, which is every row when a delta added a handful.
      uncodedPids: db.prepare(`
        SELECT p.pid AS pid
        FROM passages p LEFT JOIN vector_codes c ON c.pid = p.pid
        WHERE p.vector IS NOT NULL AND c.pid IS NULL
        ORDER BY p.pid
      `),
      // Every stride-th vector, for the mean. `pid % 1 = 0` selects all of them, which is
      // what a corpus smaller than the sample gets.
      sampleVectors: db.prepare('SELECT vector FROM passages WHERE vector IS NOT NULL AND pid % ? = 0'),
    };
  }

  /** Open a write transaction on the first mutation; save() is what commits it. */
  private begin(): void {
    if (this.inTransaction) return;
    this.handle.exec('BEGIN');
    this.inTransaction = true;
  }

  private commit(): void {
    if (!this.inTransaction) return;
    this.handle.exec('COMMIT');
    this.inTransaction = false;
  }

  private meta(key: string): string | undefined {
    const row = this.stmts.getMeta.get(key) as { value?: string } | undefined;
    return row?.value;
  }

  private loadMeta(): void {
    this.builtFromVersion = Number(this.meta('builtFromVersion') ?? 0) || 0;
    this.itemsTotal = Number(this.meta('itemsTotal') ?? 0) || 0;
    this.itemsAvailable = Number(this.meta('itemsAvailable') ?? 0) || 0;
    this.vectorEmbedderId = this.meta('embedderId') || undefined;
    // Absent in databases written before incremental updates: version 0 blocks an update,
    // which is the safe answer (one full build stamps it and every later update is cheap).
    this.libraryVersion = Number(this.meta('libraryVersion') ?? 0) || 0;
    const backend = this.meta('libraryBackend');
    this.libraryBackend = backend === 'local' || backend === 'cloud' ? backend : undefined;
    // Absent in databases written before the full-text cursor existed; 0 then means the
    // coverage gap is unknown, which the first update closes once (#26).
    this.fulltextVersion = Number(this.meta('fulltextVersion') ?? 0) || 0;
    this.checkpoint = parseCheckpoint(this.meta('checkpoint'));
    this.paused = this.meta('paused') === 'true';
    // Absent in databases written before the library stamp: an unstamped index refuses
    // nothing (assertLibrary), so old files keep building rather than stranding.
    this.library = this.meta('library') || undefined;
    // Absent in databases written before the droplist: such an index prunes nothing until
    // its next build or update derives one, which is the same adoption the library stamp
    // gets. `??` and not `||`, so a genuinely empty droplist stays a derivation.
    const droplist = this.meta('droplist');
    this.dropSet = droplist === undefined ? undefined : new Set(droplist.split(' ').filter(Boolean));
    this.dropSetPassages = Number(this.meta('droplistPassages') ?? 0) || 0;
    // An index that HOLDS full-text passages counts as full-text-enabled, even before this
    // process runs a build of its own (same rule as the JSON backend's load).
    this.fulltextEnabled = this.c.fulltextPassages > 0;
    this.ownWordsEnabled = this.c.ownWordsPassages > 0;
    this.reconcileVectorProvenance();
  }

  private writeMeta(paused = this.paused): void {
    const set = this.stmts.setMeta;
    set.run('builtFromVersion', String(this.builtFromVersion));
    set.run('itemsTotal', String(this.itemsTotal));
    set.run('itemsAvailable', String(this.itemsAvailable));
    set.run('embedderId', this.vectorEmbedderId ?? '');
    set.run('libraryVersion', String(this.libraryVersion));
    set.run('libraryBackend', this.libraryBackend ?? '');
    set.run('fulltextVersion', String(this.fulltextVersion));
    // One JSON row rather than a column per field, deliberately: the checkpoint's shape
    // belongs to the build loop and will grow with it, and the meta table is exactly the
    // place a value can be added without a schema version bump: an older build ignores a
    // key it does not know, so a database written here still opens there.
    set.run('checkpoint', this.checkpoint ? JSON.stringify(this.checkpoint) : '');
    set.run('paused', String(paused));
    set.run('library', this.library ?? '');
  }

  private refreshCounts(): void {
    const db = this.handle;
    const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    this.c = {
      documents: one('SELECT COUNT(*) AS n FROM passages'),
      vectors: one('SELECT COUNT(*) AS n FROM passages WHERE vector IS NOT NULL'),
      items: one('SELECT COUNT(*) AS n FROM items'),
      fulltextItems: 0,
      fulltextPassages: one("SELECT COUNT(*) AS n FROM passages WHERE source = 'fulltext'"),
      ownWordsItems: 0,
      ownWordsPassages: one("SELECT COUNT(*) AS n FROM passages WHERE source IN ('note', 'annotation')"),
    };
    this.fulltextKeys = new Set(
      (db.prepare("SELECT DISTINCT item_key AS k FROM passages WHERE source = 'fulltext'").all() as Array<{
        k: string;
      }>).map((r) => r.k),
    );
    this.c.fulltextItems = this.fulltextKeys.size;
    this.ownWordsKeys = new Set(
      (db
        .prepare("SELECT DISTINCT item_key AS k FROM passages WHERE source IN ('note', 'annotation')")
        .all() as Array<{ k: string }>).map((r) => r.k),
    );
    this.c.ownWordsItems = this.ownWordsKeys.size;
    // One rowid probe, not a count: all this decides is whether a write has a code to
    // invalidate. Counting them would read the whole codes table on every rollback.
    this.hasCodes = this.stmts.anyCode.get() !== undefined;
    this.invalidateCodes();
  }

  /**
   * Import a legacy JSON index once, when this database is created. The file is left in
   * place: it is the fallback for a downgrade to an older Node, and nothing here needs to
   * delete a user's data to succeed.
   */
  private async importJson(jsonPath: string): Promise<void> {
    let bytes: number;
    try {
      bytes = (await stat(jsonPath)).size;
    } catch {
      return; // no legacy index: a fresh install, or one already migrated
    }
    if (bytes > this.maxMigrationBytes) {
      this.storeNotice =
        `A ${Math.round(bytes / 1024 / 1024)} MB search-index.json was found but NOT imported: reading it needs ` +
        'roughly ten times its size in heap and would crash the server, which is the limit this SQLite index ' +
        'removes. The JSON file was left untouched. Run zotero_index action:"build" once to rebuild the library ' +
        'into the SQLite index.';
      this.opts.logger?.warn(this.storeNotice);
      return;
    }
    let snapshot: IndexSnapshot;
    try {
      snapshot = JSON.parse(await readFile(jsonPath, 'utf8')) as IndexSnapshot;
    } catch (e) {
      this.storeNotice =
        `search-index.json could not be imported (${e instanceof Error ? e.message : String(e)}). ` +
        'Run zotero_index action:"build" to rebuild the index.';
      this.opts.logger?.warn(this.storeNotice);
      return;
    }
    this.begin();
    for (const rec of snapshot.chunks ?? []) {
      this.putItem(rec.itemKey, rec.title);
      this.putPassage(rec);
    }
    for (const v of snapshot.vectors ?? []) this.putVector(v.id, v.vector);
    this.builtFromVersion = snapshot.builtFromVersion ?? 0;
    this.itemsTotal = snapshot.itemsTotal ?? 0;
    this.itemsAvailable = snapshot.itemsAvailable ?? 0;
    this.vectorEmbedderId = snapshot.embedderId;
    // The build cursors travel with the rows they describe: a JSON index whose build was
    // interrupted is resumable once it is in SQLite too, and one migrated mid-coverage
    // keeps knowing how far into Zotero's full-text sequence it read.
    this.fulltextVersion = snapshot.fulltextVersion ?? 0;
    this.checkpoint = snapshot.checkpoint;
    this.paused = snapshot.paused ?? false;
    this.writeMeta();
    this.commit();
    this.storeNotice =
      `Imported ${this.c.documents} passages and ${this.c.vectors} vectors from search-index.json into the ` +
      'SQLite index. The JSON file was left in place and is no longer read.';
    this.opts.logger?.info(this.storeNotice);
  }

  protected counts(): IndexCounts {
    return { ...this.c };
  }

  protected clearStore(): void {
    this.begin();
    // 'delete-all' is how an external-content FTS5 index is emptied; deleting the content
    // rows alone would leave the index pointing at rowids that no longer exist.
    this.handle.exec("INSERT INTO passages_fts(passages_fts) VALUES('delete-all')");
    this.handle.exec('DELETE FROM passages');
    this.handle.exec('DELETE FROM items');
    this.dropCodes();
    this.c = {
      documents: 0,
      vectors: 0,
      items: 0,
      fulltextItems: 0,
      fulltextPassages: 0,
      ownWordsItems: 0,
      ownWordsPassages: 0,
    };
    this.fulltextKeys = new Set();
    this.ownWordsKeys = new Set();
  }

  protected putItem(itemKey: string, title: string): void {
    this.begin();
    const res = this.stmts.insertItem.run(itemKey, title);
    if (Number(res.changes) > 0) this.c.items++;
  }

  protected putPassage(rec: ChunkRecord): void {
    this.begin();
    const res = this.stmts.insertPassage.run(rec.id, rec.itemKey, rec.title, rec.text, rec.source ?? null);
    // Normalized once, here, so what FTS tokenizes is exactly what the JS query side
    // produces (NFC, unicode61-aware case fold) — unicode61 itself normalizes nothing.
    // The delete sites below re-derive the same string from passages.text, which the
    // external-content protocol requires to match byte for byte. The expansion map is NOT
    // maintained here: it is derived state with a cadence (refreshAccentVariants), like
    // the binary vector codes beside it.
    this.stmts.insertFts.run(Number(res.lastInsertRowid), normalizeForSearch(rec.text));
    this.c.documents++;
    if (rec.source === 'fulltext') {
      this.c.fulltextPassages++;
      if (!this.fulltextKeys.has(rec.itemKey)) {
        this.fulltextKeys.add(rec.itemKey);
        this.c.fulltextItems++;
      }
    } else if (rec.source === 'note' || rec.source === 'annotation') {
      this.c.ownWordsPassages++;
      if (!this.ownWordsKeys.has(rec.itemKey)) {
        this.ownWordsKeys.add(rec.itemKey);
        this.c.ownWordsItems++;
      }
    }
  }

  /**
   * Remove one item: its FTS5 rows first (through the external-content delete protocol,
   * while the text they were indexed from is still readable), then the passages that hold
   * that text, then the item row itself. Counts are adjusted from the rows that were
   * actually removed rather than re-counted, so a delete costs the item, not the index.
   */
  protected deleteItem(itemKey: string): void {
    this.begin();
    // Before the passages go: the codes are keyed by their rowids, and after the delete
    // there is nothing left to name them by.
    if (this.hasCodes) this.stmts.deleteItemCodes.run(itemKey);
    this.invalidateCodes();
    const rows = this.stmts.itemPassages.all(itemKey) as Array<{
      pid: number;
      text: string;
      source: string | null;
      has_vector: number;
    }>;
    for (const row of rows) {
      this.stmts.deleteFts.run(row.pid, normalizeForSearch(row.text));
      this.c.documents--;
      if (row.has_vector) this.c.vectors--;
      if (row.source === 'fulltext') this.c.fulltextPassages--;
      else if (row.source === 'note' || row.source === 'annotation') this.c.ownWordsPassages--;
    }
    this.stmts.deletePassages.run(itemKey);
    if (this.fulltextKeys.delete(itemKey)) this.c.fulltextItems--;
    if (this.ownWordsKeys.delete(itemKey)) this.c.ownWordsItems--;
    if (Number(this.stmts.deleteItemRow.run(itemKey).changes) > 0) this.c.items--;
  }

  protected listItemKeys(): string[] {
    return (this.stmts.itemKeys.all() as Array<{ k: string }>).map((r) => r.k);
  }

  protected listItems(): Array<{ key: string; title: string }> {
    return (this.stmts.itemRows.all() as Array<{ k: string; t: string }>).map((r) => ({ key: r.k, title: r.t }));
  }

  protected itemTitle(itemKey: string): string | undefined {
    return (this.stmts.itemTitle.get(itemKey) as { t?: string } | undefined)?.t;
  }

  protected hasFulltext(itemKey: string): boolean {
    // The resident set refreshCounts/putPassage maintain, so a resume's worklist filter
    // costs no query per item.
    return this.fulltextKeys.has(itemKey);
  }

  /**
   * The body half of `deleteItem`: the same external-content FTS5 protocol, applied to
   * this item's `source = 'fulltext'` rows only, so its metadata passages (and the item
   * row itself) stay exactly where they are.
   */
  protected clearFulltext(itemKey: string): void {
    this.begin();
    const rows = this.stmts.itemFulltext.all(itemKey) as Array<{ pid: number; text: string; has_vector: number }>;
    for (const row of rows) {
      this.stmts.deleteFts.run(row.pid, normalizeForSearch(row.text));
      this.c.documents--;
      this.c.fulltextPassages--;
      if (row.has_vector) this.c.vectors--;
    }
    this.stmts.deleteFulltext.run(itemKey);
    if (this.fulltextKeys.delete(itemKey)) this.c.fulltextItems--;
  }

  protected ownWordsPassageIds(): string[] {
    return (this.stmts.ownWordsIds.all() as Array<{ id: string }>).map((r) => r.id);
  }

  /** The own-words twin of `clearFulltext`, down to the external-content delete protocol. */
  protected clearOwnWords(itemKey: string): void {
    this.begin();
    const rows = this.stmts.itemOwnWords.all(itemKey) as Array<{ pid: number; text: string; has_vector: number }>;
    for (const row of rows) {
      this.stmts.deleteFts.run(row.pid, normalizeForSearch(row.text));
      this.c.documents--;
      this.c.ownWordsPassages--;
      if (row.has_vector) this.c.vectors--;
    }
    this.stmts.deleteOwnWords.run(itemKey);
    if (this.ownWordsKeys.delete(itemKey)) this.c.ownWordsItems--;
  }

  /**
   * Discard the open transaction, i.e. everything an update wrote, and re-read the
   * database's own view of itself. The in-memory counters and meta fields are derived
   * state: after a rollback they describe rows that no longer exist unless reloaded.
   */
  protected rollback(): boolean {
    if (!this.db) return false;
    if (this.inTransaction) {
      this.handle.exec('ROLLBACK');
      this.inTransaction = false;
    }
    this.refreshCounts();
    this.loadMeta();
    return true;
  }

  protected putVector(id: string, vector: number[]): void {
    this.begin();
    const blob = Buffer.from(Float32Array.from(vector).buffer);
    // Each passage is embedded once per build, so a changed row is a new vector.
    if (Number(this.stmts.setVector.run(blob, id).changes) > 0) this.c.vectors++;
    // A code describes the vector it was taken from, so a new vector retires it. Skipped
    // while the database holds no code at all, which is the whole of a fresh build: it
    // would otherwise be a statement per passage to delete nothing.
    if (this.hasCodes) this.stmts.deletePassageCode.run(id);
    this.invalidateCodes();
  }

  protected passagesMissingVectors(limit: number): ChunkRecord[] {
    try {
      return (this.stmts.unembedded.all(limit) as unknown as PassageRow[]).map((row) => {
        const rec: ChunkRecord = { id: row.id, itemKey: row.item_key, title: row.title, text: row.text };
        if (row.source === 'fulltext' || row.source === 'note' || row.source === 'annotation') rec.source = row.source;
        return rec;
      });
    } catch (e) {
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      throw e;
    }
  }

  protected clearVectors(): void {
    this.begin();
    this.handle.exec('UPDATE passages SET vector = NULL');
    this.dropCodes();
    this.c.vectors = 0;
  }

  /**
   * Committed straight away, unlike a build's writes: dropping vectors happens on open or
   * mid-query, and an open write transaction would then hold the database's writer lock
   * for the rest of the process.
   */
  protected dropStaleVectors(cause: string): void {
    super.dropStaleVectors(cause);
    this.flush();
  }

  protected vectorDimension(): number | undefined {
    const row = this.stmts.vectorWidth.get() as { bytes?: number } | undefined;
    return row?.bytes === undefined ? undefined : row.bytes / Float32Array.BYTES_PER_ELEMENT;
  }

  /**
   * FTS5 ranks with bm25() (negative, best first), which is negated here so both backends
   * report "higher is better". Terms are OR-ed: FTS5's implicit AND between terms answers
   * far fewer queries than the BM25 index does, where a document matching one term of
   * three still scores. Fusion downstream cares about the ORDER of these hits, not the
   * scale of their scores.
   */
  protected keywordSearch(q: string, topK: number): RankedId[] {
    const terms = pruneTerms([...new Set(tokenize(q))], this.highDf(), 'raw');
    if (!terms.length) return [];
    const match = terms.map((t) => this.expandTerm(t)).join(' OR ');
    try {
      const rows = this.stmts.keyword.all(match, topK) as Array<{ id: string; rank: number }>;
      return rows.map((r) => ({ id: r.id, score: -r.rank }));
    } catch (e) {
      // A file that has gone bad under us is not a rejected query, and must not be
      // swallowed into an empty result set: an index that answers "no matches" forever
      // reads as an empty library rather than as a fault.
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      // Everything that is not SQLite rejecting the match string we just built propagates.
      // This catch was written for that one condition and implemented as swallow-anything,
      // so `disk I/O error`, `no such table: passages`, a locked database and an
      // interrupted statement all came back as an empty library (#21).
      if (!isQuerySyntaxError(e)) throw e;
      // A term the FTS5 parser rejects must not take the whole search down with it.
      this.opts.logger?.debug(`FTS5 query rejected (${match}): ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * One query term as its MATCH fragment: the term itself, OR-grouped with the accented
   * spellings the index holds for it when the term carries no marks of its own.
   *
   * The direction is deliberate and asymmetric. An unaccented term expands — accents are
   * the first thing lost to keyboards, copy-paste and OCR, so `theorie` runs as
   * `("theorie" OR "théorie")` and reaches the accented documents without one extra token
   * in the index. An accented term never expands: folding `thể` toward `the` is the
   * vocabulary merge this change exists to end. Each variant keeps its own idf under
   * FTS5's bm25 — a rare accented spelling stays rare.
   */
  private expandTerm(term: string): string {
    // ZOTEUS_ACCENT_EXPANSION=false opts into strict as-typed exactness. Only this query
    // step is gated: the index, the migration and the variants map are the same either
    // way, so flipping the flag never needs a rebuild.
    if (!(this.opts.accentExpansion ?? true)) return ftsTerm(term);
    if (accentKey(term) !== term) return ftsTerm(term);
    const rows = this.stmts.variantsFor.all(term) as Array<{ term: string; df: number }>;
    const variants = rows.filter((v) => v.term !== term);
    if (!variants.length) return ftsTerm(term);
    // The dominance gate, measured before it was trusted: expand only when the accented
    // spellings outweigh the typed one in this corpus. Without it, every rare accented
    // sibling of a common word joins the query at a HIGH idf — `trong` (25 771 passages)
    // dragged in `trọng`, `trồng` and four more, `le` dragged in nine Vietnamese words,
    // OCR's `enêrgy` outranked real hits for `energy` — and top-1 agreement with stock
    // fell to 10-15 of 20 per language. With it, a query is read the way this library
    // predominantly spells it: `theorie` (214 against 955 accented) expands, `trong`
    // (25 771 against 7 027) runs as typed. Corpus-derived, no threshold to tune.
    const selfDf = (rows.find((v) => v.term === term)?.df ?? 0);
    const variantsDf = variants.reduce((s, v) => s + v.df, 0);
    if (variantsDf <= selfDf) return ftsTerm(term);
    // Capped, best spellings first, so no key can grow a query without bound: the widest
    // group a real 477 512-passage EN/FR/VI library produced was 15 spellings, and a
    // document seeded with hundreds of crafted spellings of one key must cost the
    // attacker an indexing job, not every future user a posting-list merge per spelling.
    const kept = [...variants].sort((a, b) => b.df - a.df).slice(0, MAX_ACCENT_VARIANTS);
    const group = [term, ...kept.map((v) => v.term)].map(ftsTerm).join(' OR ');
    return `(${group})`;
  }

  /**
   * Vector candidates, best first, through whichever of the two paths can serve this query.
   *
   * The exact scan below reads every stored vector, which is linear in the size of the
   * index and in the width of the vectors: 255,703 passages at 3072 dimensions is 3.1 GB
   * decoded and multiplied per query, measured at 90 to 105 seconds (#30). The coded path
   * reads 98 MB of sign bits instead and only fetches the float32 vectors of the few
   * hundred candidates it hands the exact rescore, so the ranking it returns is exact
   * cosine over a neighbourhood the codes found. `codesFor` decides between them, and
   * records which one served the query on the status.
   */
  protected vectorSearch(query: number[], topK: number): RankedId[] {
    this.vectorScans++;
    const wanted = Math.max(topK * this.annOversample, this.annMinCandidates);
    const cache = this.codesFor(wanted, query.length);
    if (!cache) {
      this.vectorScan = 'exact';
      return this.exactVectorSearch(query, topK);
    }
    this.vectorScan = 'codes';
    return this.codedVectorSearch(query, topK, cache, wanted);
  }

  /**
   * Cosine over the stored vectors, streamed one row at a time and kept to the top K, so
   * a semantic query costs the size of its result set rather than the size of the index.
   */
  private exactVectorSearch(query: number[], topK: number): RankedId[] {
    const qn = norm(query);
    if (qn === 0) return [];
    const top: RankedId[] = [];
    for (const row of this.stmts.vectors.iterate() as Iterable<{ id: string; vector: Uint8Array }>) {
      const score = cosine(query, toFloats(row.vector), qn);
      if (score <= 0) continue;
      if (top.length >= topK && score <= top[top.length - 1]!.score) continue;
      let i = top.length;
      while (i > 0 && top[i - 1]!.score < score) i--;
      top.splice(i, 0, { id: row.id, score });
      if (top.length > topK) top.pop();
    }
    return top;
  }

  /**
   * The two-stage search: Hamming over the resident codes for a candidate pool, then the
   * exact cosine over those candidates' real vectors.
   *
   * The second stage is not an optimization, it is what makes the first one usable. Binary
   * codes alone recalled 0.592 of the exact top 30 on real embeddings; the same codes with
   * this rescore recalled 0.953 at an 8x pool and 0.986 at 16x (#30). The codes find the
   * neighbourhood and cannot order inside it, so every score returned here comes from the
   * float32 vector, and the page this returns is ordered by exact cosine.
   */
  private codedVectorSearch(query: number[], topK: number, cache: CodeCache, wanted: number): RankedId[] {
    const qn = norm(query);
    if (qn === 0) return [];
    // The query is centred and thresholded exactly as every stored vector was. Through
    // Float32Array so it meets `packCode` in the same shape the rows do, and because
    // rounding a coordinate to float32 cannot move it across zero.
    const words = new Uint32Array(cache.words);
    unpackCode(packCode(Float32Array.from(query), cache.mean, cache.words), words, 0, cache.words);

    const picked = this.nearestByHamming(words, cache, wanted);
    const hits: RankedId[] = [];
    for (let at = 0; at < picked.length; at += RESCORE_BATCH) {
      const batch = picked.slice(at, at + RESCORE_BATCH);
      const rows = this.rescoreStatement(batch.length).all(...batch) as Array<{ id: string; vector: Uint8Array }>;
      for (const row of rows) {
        const score = cosine(query, toFloats(row.vector), qn);
        if (score > 0) hits.push({ id: row.id, score });
      }
    }
    // Sorted rather than threaded through a running top-K: this is a few hundred rows, not
    // a quarter of a million, and V8's sort is stable, so rows of equal score keep the
    // rowid order SQLite returned them in, which is the order the exact scan ranks them in.
    hits.sort((a, b) => b.score - a.score);
    return hits.length > topK ? hits.slice(0, topK) : hits;
  }

  /**
   * The rowids of the `want` codes nearest the query, in rowid order.
   *
   * Distances are counted into a histogram and cut at a threshold rather than pushed
   * through a heap: a Hamming distance is a small integer bounded by the width of a code,
   * so counting sort answers "the best N of them" in one more pass over an array of
   * 16-bit integers, with no comparisons and no allocation per row.
   */
  private nearestByHamming(query: Uint32Array, cache: CodeCache, want: number): number[] {
    const { codes, words, dists } = cache;
    const n = dists.length;
    const histogram = new Uint32Array(cache.words * 32 + 1);
    for (let i = 0, at = 0; i < n; i++, at += words) {
      let d = 0;
      for (let w = 0; w < words; w++) {
        // SWAR popcount of one XOR word (Hacker's Delight): five masked shifts, no lookup
        // table and no BigInt. The BigInt spelling is the obvious one in JavaScript and it
        // is a trap: measured at 18,635 ms against 97 ms for this loop over the same
        // 255k 3072-bit codes, which is slower than the exact float scan it replaces (#30).
        let x = (codes[at + w]! ^ query[w]!) >>> 0;
        x -= (x >>> 1) & 0x55555555;
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        d += Math.imul(x, 0x01010101) >>> 24;
      }
      dists[i] = d;
      histogram[d]!++;
    }
    // The first distance whose bucket would overflow the pool: everything nearer is taken
    // whole, and that bucket fills what is left.
    let cutoff = 0;
    let nearer = 0;
    while (cutoff < histogram.length && nearer + histogram[cutoff]! <= want) {
      nearer += histogram[cutoff]!;
      cutoff++;
    }
    let room = want - nearer;
    const picked: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = dists[i]!;
      if (d < cutoff) picked.push(cache.pids[i]!);
      else if (d === cutoff && room > 0) {
        picked.push(cache.pids[i]!);
        room--;
      }
    }
    return picked;
  }

  /**
   * The statement that fetches one batch of candidates by rowid. One statement per batch
   * rather than one per row: on the measured shape, issuing a statement per candidate was
   * about half the cost of the entire two-stage query (#30).
   */
  private rescoreStatement(size: number): StatementSync {
    let stmt = this.rescoreStmts.get(size);
    if (!stmt) {
      // Sizes come from RESCORE_BATCH and one remainder, so this holds two entries for a
      // given `limit`. Cleared rather than grown without bound if a caller sweeps limits.
      if (this.rescoreStmts.size >= 8) this.rescoreStmts.clear();
      stmt = this.handle.prepare(`SELECT id, vector FROM passages WHERE pid IN (${'?, '.repeat(size - 1)}?)`);
      this.rescoreStmts.set(size, stmt);
    }
    return stmt;
  }

  /**
   * The resident codes, if they can serve a query for `wanted` candidates at this width,
   * building them first where that is this process's job. Every path that returns nothing
   * says why on the status, because an index that quietly went back to the scan this
   * exists to avoid is indistinguishable from one that is simply slow.
   */
  private codesFor(wanted: number, queryWidth: number): CodeCache | undefined {
    const decline = (why: string): undefined => {
      this.vectorScanNotice = why;
      return undefined;
    };
    if (!this.annEnabled) {
      return decline('Two-stage vector search is off (ZOTEUS_INDEX_ANN=false), so every stored vector was scanned.');
    }
    if (this.c.vectors <= wanted) {
      return decline(
        `The index holds ${this.c.vectors} vectors, no more than the ${wanted} candidates the code stage would ` +
          'hand the exact rescore, so every vector was scanned: there is nothing for the codes to narrow.',
      );
    }
    if (this.codesUnusable) return decline(this.codesUnusable);
    let note: string | undefined;
    if (!this.codeCache) {
      if (this.isBuilding) {
        // A refusal to write, not to search. Building the codes here would commit the
        // transaction the running build or update is holding open, and an update that
        // failed afterwards could no longer be rolled back.
        return decline(
          'An index build or update is running, so the binary codes were left untouched and every vector was scanned.',
        );
      }
      note = this.buildCodes();
      if (!this.codeCache) {
        return decline(this.codesUnusable ?? 'The binary codes are unavailable, so every vector was scanned.');
      }
    }
    const cache = this.codeCache;
    if (queryWidth !== cache.dim) {
      return decline(
        `The query has ${queryWidth} dimensions and the codes were taken from ${cache.dim}-dimensional vectors, ` +
          'so every vector was scanned.',
      );
    }
    this.vectorScanNotice = note;
    return cache;
  }

  /**
   * Write whatever codes are missing, commit them, and load them into this process.
   *
   * Returns the sentence to report when this had to be done inside a query, which is the
   * upgrade path: an index built before the codes existed pays one vector scan to gain
   * them, once, and that scan is the same one every query was paying until now. Failure is
   * recorded and never thrown: the codes are a cache, and an index without them is slow
   * rather than broken.
   */
  private buildCodes(): string | undefined {
    const dim = this.vectorDimension();
    if (dim === undefined || dim === 0) {
      this.codesUnusable = 'The stored vectors have no readable width, so every vector was scanned.';
      return undefined;
    }
    const started = Date.now();
    let written = 0;
    try {
      written = this.refreshCodes(dim);
      // Committed straight away, for the same reason dropStaleVectors is: this runs inside
      // a query, and an open write transaction would hold the writer lock for the rest of
      // the process, against a second Zoteus sharing the data dir (#18).
      this.flush();
    } catch (e) {
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      this.codesUnusable =
        `The binary search codes could not be built (${e instanceof Error ? e.message : String(e)}), so every ` +
        'stored vector is being scanned instead.';
      this.opts.logger?.warn(this.codesUnusable);
      return undefined;
    }
    const loaded = this.loadCodes(dim);
    if (typeof loaded === 'string') {
      this.codesUnusable = `${loaded} Every stored vector is being scanned instead; zotero_index action:"build" rebuilds the codes.`;
      this.opts.logger?.warn(this.codesUnusable);
      return undefined;
    }
    this.codeCache = loaded;
    if (!written) return undefined;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const notice =
      `Binary search codes were built for ${written} vectors in ${seconds}s, once, inside this query: this index ` +
      'was written before it carried them. They are stored in the index file and every later query uses them.';
    this.opts.logger?.info(notice);
    return notice;
  }

  /**
   * Bring `vector_codes` level with the stored vectors, and return how many were written.
   *
   * Two shapes of work, and the difference is the whole cost model. With a mean already
   * taken at this width, only the vectors that carry no code are read: that is a delta
   * update's handful of passages, found without touching the vectors of the rows it skips.
   * Without one (a first build, or vectors that changed width) every code is taken again,
   * one pass, which is what the very first semantic query on an upgraded index pays.
   */
  private refreshCodes(dim: number): number {
    if (this.c.vectors === 0) return 0;
    const words = Math.ceil(dim / 32);
    const mean = this.storedMean(dim);
    this.begin();
    let written = 0;
    if (mean) {
      // Materialized before the first insert: a statement that reads `vector_codes` must
      // not still be open while this writes into it.
      const pids = (this.stmts.uncodedPids.all() as Array<{ pid: number }>).map((r) => Number(r.pid));
      for (const pid of pids) {
        const row = this.stmts.vectorByPid.get(pid) as { vector?: Uint8Array } | undefined;
        if (!row?.vector) continue;
        const v = toFloats(row.vector);
        // A vector of another width cannot be coded against this mean. Left alone rather
        // than coded wrongly: the coverage check below then keeps the whole path off.
        if (v.length !== dim) continue;
        this.stmts.insertCode.run(pid, packCode(v, mean, words));
        written++;
      }
    } else {
      this.dropCodes();
      const fresh = this.sampleMean(dim);
      this.stmts.setMeta.run(CODE_MEAN, encodeMean(fresh));
      this.stmts.setMeta.run(CODE_DIM, String(dim));
      // Reading `passages` while writing `vector_codes`: different tables, so the scan is
      // not walking a b-tree these inserts are changing under it.
      for (const row of this.stmts.vectorRows.iterate() as Iterable<{ pid: number; vector: Uint8Array }>) {
        const v = toFloats(row.vector);
        if (v.length !== dim) continue;
        this.stmts.insertCode.run(Number(row.pid), packCode(v, fresh, words));
        written++;
      }
    }
    if (written) this.hasCodes = true;
    this.invalidateCodes();
    return written;
  }

  /**
   * Read every code into one Uint32Array, or say why they cannot be used.
   *
   * The check that matters is the count: one code per stored vector, no more and no fewer.
   * Fewer means a writer added vectors without coding them; more means one deleted passages
   * without deleting their codes, and a code left behind eventually describes whichever
   * passage inherits its rowid. Neither can produce a wrong score (every score comes from a
   * real vector fetched by rowid), but both cost recall silently, so both send the query
   * back to the exact scan until a build or an update rebuilds the codes.
   */
  private loadCodes(dim: number): CodeCache | string {
    const mean = this.storedMean(dim);
    if (!mean) return `No corpus mean is stored for ${dim}-dimensional vectors, so the binary codes cannot be read.`;
    const words = Math.ceil(dim / 32);
    const n = this.c.vectors;
    const codes = new Uint32Array(n * words);
    const pids = new Float64Array(n);
    let i = 0;
    let width: number | undefined;
    for (const row of this.stmts.allCodes.iterate() as Iterable<{ pid: number; code: Uint8Array }>) {
      if (i >= n) {
        i++;
        break;
      }
      if (row.code.byteLength !== words * 4) {
        width = row.code.byteLength;
        break;
      }
      pids[i] = Number(row.pid);
      unpackCode(row.code, codes, i * words, words);
      i++;
    }
    if (width !== undefined) {
      return `A stored binary code is ${width} bytes where ${dim}-dimensional vectors need ${words * 4}.`;
    }
    if (i > n) return `There are more binary codes than the ${n} stored vectors they must describe.`;
    if (i !== n) return `The binary codes cover ${i} of the ${n} stored vectors.`;
    return { dim, words, pids, codes, mean, dists: new Uint16Array(n) };
  }

  /**
   * The corpus mean, averaged over a strided sample of the vectors. Every stride-th rowid
   * rather than the first N: passages are stored in the order they were indexed, so a
   * prefix is the first few hundred items of the library and carries their subjects with it.
   */
  private sampleMean(dim: number): Float32Array {
    const stride = Math.max(1, Math.floor(this.c.vectors / MEAN_SAMPLE));
    const sum = new Float64Array(dim);
    let n = 0;
    for (const row of this.stmts.sampleVectors.iterate(stride) as Iterable<{ vector: Uint8Array }>) {
      const v = toFloats(row.vector);
      if (v.length !== dim) continue;
      for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
      n++;
    }
    const mean = new Float32Array(dim);
    // Centring on nothing is centring on zero, which is the plain sign bits: worse codes,
    // never wrong ones.
    if (n === 0) return mean;
    for (let i = 0; i < dim; i++) mean[i] = sum[i]! / n;
    return mean;
  }

  /** The stored mean, when one was taken from vectors of exactly this width. */
  private storedMean(dim: number): Float32Array | undefined {
    if (Number(this.meta(CODE_DIM) ?? 0) !== dim) return undefined;
    const encoded = this.meta(CODE_MEAN);
    if (!encoded) return undefined;
    return decodeMean(encoded, dim);
  }

  /** Forget the resident codes, and any verdict about them. Any write to a vector does this. */
  private invalidateCodes(): void {
    this.codeCache = undefined;
    this.codesUnusable = undefined;
  }

  /** Drop every code and the mean they were centred on, so the next refresh takes both again. */
  private dropCodes(): void {
    this.begin();
    this.handle.exec('DELETE FROM vector_codes');
    this.stmts.setMeta.run(CODE_MEAN, '');
    this.stmts.setMeta.run(CODE_DIM, '0');
    this.hasCodes = false;
    this.invalidateCodes();
  }

  /**
   * Rebuild the codes for whatever a build or an update has just written, inside that
   * job's own transaction. Never throws: a cache that could not be built leaves a slower
   * index, and failing a build over it would be losing the library to save the cache.
   */
  protected finalizeVectors(): void {
    // The expansion map is derived from the keyword vocabulary exactly as the binary
    // codes below are derived from the vectors, and it levels up at the same moment, for
    // the same reason: the derived rows commit with the rows they were derived from.
    // Same contract too — never throw; a map that could not be refreshed is yesterday's
    // expansions, not a failed build.
    try {
      this.refreshAccentVariants();
    } catch (e) {
      this.opts.logger?.warn(`accent variants not refreshed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // What the salvage actually spared, reported where the numbers are final rather than
    // promised in the future tense the sideline had to use. Rewritten from the sideline's
    // own sentence each time, so a second job over the same index updates the figure
    // instead of appending a second one.
    if (this.salvage && this.salvagedVectors > 0) {
      const preamble = this.sidelineNotice ? `${this.sidelineNotice} ` : '';
      this.storeNotice =
        `${preamble}So far ${this.salvagedVectors} vector(s) have been reused from ${this.salvage.path} rather ` +
        'than re-embedded.';
    }
    // An index too small for the codes to narrow anything never reads them, so it is not
    // made to carry them either: below the candidate floor, every query scans exactly.
    if (!this.db || !this.annEnabled || this.c.vectors <= this.annMinCandidates) return;
    const dim = this.vectorDimension();
    if (dim === undefined || dim === 0) return;
    try {
      const written = this.refreshCodes(dim);
      if (written) this.opts.logger?.debug(`search index: ${written} binary vector codes written`);
    } catch (e) {
      if (isCorruptionError(e)) {
        this.noteCorruption(e);
        return;
      }
      this.opts.logger?.warn(
        `The binary search codes could not be built (${e instanceof Error ? e.message : String(e)}); ` +
          'semantic queries will scan every vector instead.',
      );
    }
  }

  protected highDf(): TermPredicate | undefined {
    const drop = this.dropSet;
    if (!drop) return undefined;
    return (t: string) => drop.has(t);
  }

  /**
   * Derive this library's droplist from the keyword index and store it, when the corpus has
   * moved far enough to be worth the scan.
   *
   * **Why derived state, when FTS5 already knows every term's document frequency.** It does
   * not know it in a form that can be asked. `fts5vocab` is a virtual table over the index
   * that already exists — no migration, no rebuild, nothing stored — but it is ordered by
   * term, not by document count, so a "which terms exceed 30%" question is a full scan of
   * it: measured over 639 888 terms on a 477 512-passage library at 2 020 ms on a first
   * call and 1 774 ms on a second (an earlier pair on the same machine read 2 281
   * and 2 013 ms). Those are WARM figures — the
   * page cache is not dropped between runs, and dropping it needs privileges a test does
   * not have, so the cold cost is unmeasured and is not guessed at here. Warm is already
   * far too slow for query time and too slow to pay at every server start. Everything else
   * about the answer is small — 23 terms, 75 bytes stored at that size — so the scan
   * happens where a full walk of the corpus is already being paid for.
   *
   * **The cadence, therefore.** At the end of a full build, which already costs ~264 s on
   * that library, so this is under 1% on top and invisible. Not on every delta, where 2 s
   * would be the one user-visible cost in the feature and where a handful of new items
   * cannot move a 30% threshold anyway — the stored passage count is what turns that into a
   * rule rather than a hope. And unconditionally when the database holds no droplist at
   * all, which is how an index built by an older version adopts one.
   *
   * The temp-schema virtual table is dropped again: `fts5vocab` reads the index it names
   * and stores nothing, so leaving it would still add a row to `sqlite_master` that an
   * older build would not understand.
   */
  protected refreshDroplist(force: boolean): void {
    if (!this.db) return;
    const passages = this.c.documents;
    if (!force && !this.droplistIsStale(passages)) return;
    try {
      this.begin();
      const db = this.handle;
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.passages_vocab USING fts5vocab('main', 'passages_fts', 'row')");
      try {
        // Too small for a proportion to mean anything: derive an empty list rather than no
        // list, so the index records that it looked and found nothing to prune.
        const rows = (passages < MIN_DERIVATION_PASSAGES
          ? []
          : db
              .prepare('SELECT term FROM temp.passages_vocab WHERE doc >= ?')
              .all(highDfMinimum(passages))) as Array<{ term: string }>;
        // A list naming every term in the vocabulary is not a list. It happens on a corpus
        // too small for a document frequency to mean anything — three passages put the bar
        // at one, so everything clears it — and the consequence is not a slow index but a
        // silent one: every query prunes to nothing and nothing is what it returns. So the
        // rule declines to act rather than acting on a statistic it does not have.
        const vocabulary = (db.prepare('SELECT count(*) AS n FROM temp.passages_vocab').get() as { n: number }).n;
        if (rows.length >= vocabulary) rows.length = 0;
        // Sorted so the stored value is a function of the corpus and not of the scan order,
        // which makes two derivations over the same index byte-comparable.
        const terms = rows.map((r) => r.term).sort();
        this.dropSet = new Set(terms);
        this.dropSetPassages = passages;
        this.stmts.setMeta.run('droplist', terms.join(' '));
        this.stmts.setMeta.run('droplistPassages', String(passages));
        this.opts.logger?.debug(`search index: droplist of ${terms.length} term(s) over ${passages} passages`);
      } finally {
        db.exec('DROP TABLE IF EXISTS temp.passages_vocab');
      }
    } catch (e) {
      if (isCorruptionError(e)) {
        this.noteCorruption(e);
        return;
      }
      // Same rule as the codes: a droplist that could not be derived is a slower index,
      // never a failed build. The previous one — or none — stays in force.
      this.opts.logger?.warn(
        `The query droplist could not be derived (${e instanceof Error ? e.message : String(e)}); ` +
          'keyword queries will be sent unpruned.',
      );
    }
  }

  /** Whether the corpus has drifted far enough since the droplist was derived to redo it. */
  private droplistIsStale(passages: number): boolean {
    if (this.dropSet === undefined) return true;
    // <= 0 rather than === 0: the count is re-read from `meta` on open, and a nonsensical
    // stored value must count as stale — a negative one would otherwise make the drift
    // ratio negative and suppress rederivation forever.
    if (this.dropSetPassages <= 0) return true;
    return Math.abs(passages - this.dropSetPassages) / this.dropSetPassages > REDERIVE_DRIFT;
  }

  protected passage(id: string): ChunkRecord | undefined {
    try {
      const row = this.stmts.selectPassage.get(id) as PassageRow | undefined;
      if (!row) return undefined;
      const rec: ChunkRecord = { id: row.id, itemKey: row.item_key, title: row.title, text: row.text };
      if (row.source === 'fulltext' || row.source === 'note' || row.source === 'annotation') rec.source = row.source;
      return rec;
    } catch (e) {
      // Corruption in the passages b-tree is discovered here — every fused hit hydrates
      // through this read — and must reach the caller as the typed refusal, not as
      // SQLite's bare sentence naming neither the file nor the way out.
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      throw e;
    }
  }

  /** Write the index-level state and commit whatever the build has inserted so far. */
  private flush(): void {
    if (!this.db) return;
    this.begin();
    this.writeMeta();
    this.commit();
  }

  protected override async persistPaused(paused: boolean): Promise<void> {
    this.refuseIfFaulted();
    this.begin();
    this.writeMeta(paused);
    this.commit();
  }

  /** Commit the build's open transaction: this is what makes the last passages durable. */
  async save(): Promise<void> {
    this.refuseIfFaulted();
    const pauseTransition = this.pauseTransition;
    if (pauseTransition) await pauseTransition.catch(() => {});
    this.flush();
  }

  async close(): Promise<void> {
    const pauseTransition = this.pauseTransition;
    if (pauseTransition) await pauseTransition.catch(() => {});
    // Released whether or not this object ever opened a database of its own: the salvage
    // is a second handle on a second file, and a server that keeps it would keep a lock
    // on the very file it told the user they may delete.
    this.salvage?.close();
    this.salvage = undefined;
    if (!this.db) return;
    // Whatever was indexed is worth keeping; an abandoned transaction would discard it.
    try {
      this.flush();
    } catch {
      this.inTransaction = false;
    }
    this.db.close();
    this.db = undefined;
  }
}

/**
 * The build checkpoint back out of its meta row.
 *
 * Validated rather than cast: this row is written by a build loop whose shape changes, and
 * a half-recognised checkpoint would resume a crawl at `undefined`, an offset that reads
 * as 0 and quietly re-indexes the library. Anything unrecognisable means "nothing to
 * resume", which is the state every index was in before this existed.
 */
function parseCheckpoint(raw: string | undefined): BuildCheckpoint | undefined {
  if (!raw) return undefined;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  if (data.phase !== 'metadata' && data.phase !== 'fulltext') return undefined;
  if (!Number.isInteger(data.crawlOffset)) return undefined;
  return {
    phase: data.phase,
    crawlOffset: data.crawlOffset,
    itemsAvailable: Number(data.itemsAvailable) || 0,
    itemsTotal: Number(data.itemsTotal) || 0,
    maxItems: Number(data.maxItems) || 0,
    crawlVersion: Number(data.crawlVersion) || 0,
    fulltext: Boolean(data.fulltext),
    ...(data.backend === 'local' || data.backend === 'cloud' ? { backend: data.backend } : {}),
    ...(typeof data.embedderId === 'string' && data.embedderId ? { embedderId: data.embedderId } : {}),
    ...(Array.isArray(data.pendingPassages)
      ? { pendingPassages: data.pendingPassages.filter((id: unknown) => typeof id === 'string') }
      : {}),
  };
}

/**
 * One query term, quoted as an FTS5 string so nothing in it is read as syntax. Tokens come
 * from tokenize.ts, whose class is \p{L}\p{N} — no quote can reach here today, and the
 * quoting is what keeps that true of a future tokenizer: an embedded double quote is
 * escaped by doubling it.
 */
function ftsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Whether this machine stores a Uint32 low byte first, which decides how a code is read. */
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/**
 * One vector as sign bits: bit i is set when coordinate i is above the corpus mean.
 *
 * The comparison IS the subtraction, done without performing it: `v[i] > mean[i]` is the
 * sign of `v[i] - mean[i]` with no rounding of its own, and a NaN coordinate compares false
 * and clears its bit rather than setting one from nothing. Bits go least-significant-first
 * within each byte, and the code is padded to a whole number of 32-bit words so reading it
 * back is one word at a time with no tail. Centring on the corpus mean is what makes these
 * bits informative: measured at nothing lost at full width and +2.7 to +4.5 recall points
 * at narrower ones, and it is what Zotero's own semantic search does
 * (zotero/zotero#6012's `modelCalibration.meanVector`).
 */
export function packCode(v: Float32Array, mean: Float32Array, words: number): Uint8Array {
  const out = new Uint8Array(words * 4);
  const n = Math.min(v.length, mean.length);
  for (let i = 0; i < n; i++) {
    if (v[i]! > mean[i]!) out[i >> 3]! |= 1 << (i & 7);
  }
  return out;
}

/**
 * One stored code into the resident word array, little-endian on every machine.
 *
 * The fast path is the same bytes reinterpreted, which is what the byte order makes true
 * here and nowhere else: a code written on a big-endian machine and scanned on a
 * little-endian one would compare bits of one dimension against bits of another. The
 * arithmetic below is what any machine falls back to, and both spellings produce the same
 * words, so a code stays readable wherever the index file is opened.
 */
export function unpackCode(code: Uint8Array, into: Uint32Array, at: number, words: number): void {
  if (LITTLE_ENDIAN && code.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0) {
    into.set(new Uint32Array(code.buffer, code.byteOffset, words), at);
    return;
  }
  for (let w = 0; w < words; w++) {
    const o = w * 4;
    into[at + w] = ((code[o]! | (code[o + 1]! << 8) | (code[o + 2]! << 16) | (code[o + 3]! << 24)) >>> 0);
  }
}

/**
 * The corpus mean as base64, and back. Written coordinate by coordinate in little-endian
 * rather than as a view over its own bytes, for the reason `unpackCode` spells out: the
 * mean and the codes have to agree about a vector, and they only do if both travel in a
 * byte order the reader does not have to guess.
 */
function encodeMean(mean: Float32Array): string {
  const bytes = Buffer.alloc(mean.length * Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < mean.length; i++) bytes.writeFloatLE(mean[i]!, i * Float32Array.BYTES_PER_ELEMENT);
  return bytes.toString('base64');
}

function decodeMean(encoded: string, dim: number): Float32Array | undefined {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) return undefined;
  const mean = new Float32Array(dim);
  for (let i = 0; i < dim; i++) mean[i] = bytes.readFloatLE(i * Float32Array.BYTES_PER_ELEMENT);
  return mean;
}

/** Float32 view over a BLOB, copying only when the buffer is not 4-byte aligned. */
function toFloats(buf: Uint8Array): Float32Array {
  if (buf.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  return new Float32Array(buf.slice().buffer);
}

/**
 * Only ever called with the query. Keeping the parameter `number[]` rather than
 * `ArrayLike<number>` is load-bearing: while this also took each row's `Float32Array`, the
 * call site saw two shapes and stayed polymorphic for the life of the process, which cost
 * about half the scan on its own.
 */
function norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/**
 * Cosine of the query against one stored vector: one traversal, two accumulators.
 *
 * The obvious spelling — `norm(b)`, then a dot-product loop — walks each row twice and
 * shares its `norm()` with the query-side call above. Both cost real time on a scan that
 * touches every vector: measured on a 255 703-row index at 3072 dimensions, 44.8 to 15.5
 * microseconds per row, a 2.9x scan, of which about half was the polymorphic call site and
 * about half the second traversal.
 *
 * The scores are bit-identical, not merely close: the same products are summed in the same
 * order. The tail loop is what keeps that true when the widths disagree, where the old
 * `norm(b)` covered all of `b` while the dot product stopped at the shorter operand. That
 * case is unreachable through `query()`, which drops stale vectors on a width change, but
 * an index holding two generations of vectors reaches it and must rank as it did before.
 */
export function cosine(a: number[], b: Float32Array, an: number): number {
  if (a.length < b.length) return cosineUneven(a, b, an);
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    dot += a[i]! * x;
    sq += x * x;
  }
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}

/**
 * The width-mismatch case, kept out of line so the scan's hot function stays small enough
 * to inline — folding it in costs about a fifth of the gain, measured. Nothing reaches this
 * through `query()`, which drops stale vectors when the query's width stops matching the
 * index's, but an index holding two generations of vectors does, and it must rank as it did
 * before: the old code summed the norm over all of `b` while stopping the product at the
 * shorter operand.
 */
function cosineUneven(a: number[], b: Float32Array, an: number): number {
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  for (let i = 0; i < b.length; i++) sq += b[i]! * b[i]!;
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}
