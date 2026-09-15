# Automatic legacy fact repair

Repair is a source-scoped, zero-provider pass inside `runExtractFacts`. It uses
`resolvePageWriteTarget`, the native page lock and one engine transaction. A
successful repair preserves fact IDs and mirrors the canonical fence into the
page cache and native search chunks before stamping ownership. The source guard is re-counted afterward.

Later eligible arrivals on already-fenced pages use repeated canonical facts
fences as one logical row stream. The repair appends each new canonical section
through the pinned `O_APPEND` handle; it never inserts into or rewrites prior
bytes. The parser, native writers and privacy stripping aggregate every section
and preserve stable row numbers.

## Supported safe path

- A tracked file has raw working bytes equal to its raw committed blob, and
  strict UTF-8 decoding preserves every byte, including a BOM. An uncommitted
  canonical append chain can also be reused or extended when every differing
  byte is an exact machine-rendered section matching a currently owned or
  still-eligible fact. This is a compatibility proof, never authorship or
  permission to rewrite, delete or commit those bytes.
- Every legacy row is exactly representable by the fence. Original confidence,
  typed numeric values and UTC timestamps are compared with the parsed output,
  not with another already-rounded rendering. Full-row JSON snapshots are read
  before planning and revalidated under `FOR UPDATE`; unknown columns refuse.
- The file either already contains a complete matching fence, or the planned
  file starts with every original byte. Only the additional suffix is written.
- `repair-file.ts` walks directories using `openat(O_DIRECTORY|O_NOFOLLOW)`,
  retains those descriptors and opens the existing regular, singly-linked file
  with `O_NOFOLLOW|O_APPEND`. Its sole mutation is a write to that pinned inode.
  There is no path-based rename, creation, truncation or unlink. If a parent or
  target is replaced even after the last check, the replacement is untouched;
  the post-write identity check reports failure. File mode and inode survive.
- The source binding is locked/revalidated with the page and fact rows. The
  body mirror, native chunk projection, fact ownership stamp and final file
  verification share the DB transaction. World facts are keyword-searchable
  after ordinary committed-only sync; private facts stay out of chunks. Chunk
  embeddings use the existing stale-embedding backfill. Quarantine and embed-skip
  markers retain their native no-chunk contract. `created_at` is preserved at full database precision through
  later atomic `DELETE RETURNING`/reinsertion of unchanged content in both
  engines. Non-null embedding/provenance/consolidation/event/dimension metadata
  without a fence representation refuses conversion.

Bun with POSIX `openat` support is required (Darwin or glibc Linux). A missing
native boundary is a refusal; there is no weaker fallback. No new service,
queue, publisher, credential or source registration is involved.

## Explicit refusals and crash recovery

The repair does **not** rewrite an existing fence to add/fill rows. A later
eligible row is emitted in a new canonical fence section at EOF and all sections
parse as one stream. Missing fields on an already-present row still report
`file_rewrite_required`; that is an actual semantic rewrite and needs review.
Unaccounted dirty files, filters whose working bytes differ from the committed
blob, unavailable files, hard links, symlinks, non-UTF8 content, unknown columns
and unrepresentable values also refuse.

The repair never stages or commits. A successful append remains an uncommitted
file change. Its search index is updated in the same transaction, without
requiring a later automatic Git publisher. A later human save
cannot be swept into a repair commit because no such commit occurs.

A crash after the append may leave uncommitted fence content. It is **never**
automatically deleted or restored, even when it can be reconstructed from DB
rows. Resemblance does not prove authorship. The DB transaction rolls back or
its outcome is verified; an unreadable outcome is reported as indeterminate.
The file remains available for review, including later human edits. A retry can
reuse a complete compatible fence without writing it; the full row snapshots
are revalidated inside the transaction. This converges after a complete append
whose rows remain eligible. Human prose, extra metadata and forgotten residue
remain actionable refusals; no bytes are removed to manufacture convergence.

Residue discovery does not require `sources.local_path`. It runs again after
stamp attempts, even for a page in the earlier eligibility list. Unknown,
unavailable or dirty residue blocks the source before BOTH phantom redirection
and reconciliation. Direct phantom callers also refuse unresolved legacy rows
at either endpoint before materializing/writing the destination. A committed
active fence row matching an expired legacy claim remains blocked: committing
ambiguous residue is not authorization to undo forgetting. Per-write checks
also examine freshly expired legacy rows against the actual cached input.

Maintenance reports guard/degraded/residue-blocked counts and diagnostic
messages; blocked work is not a quiet zero-success pass.

## Concurrency and recovery contracts

`get_page(include_content:true)` returns a content revision. `put_page` checks
`base_revision` under the native page lock before changing either sink. An
omission of active fence-owned rows needs a matching revision whose visible
body actually carried those rows. Without that proof it reports `conflict`.
Remote checks cover world-visible facts; the native hidden-row merge remains.
A deliberate omission deletes only the identified active rows after a successful
same-page import/write-through, while holding the lock. Tombstones are retained.

Reconciliation re-reads owned rows under the page lock. Missing active row
numbers report `FACTS_FENCE_UNPUBLISHED_CONFLICT`, preserving the page's facts.
A HEAD commit or an unavailable file is not evidence of the editor's base.
Restore the rows, explicitly forget their IDs, or use a revision-checked save.
This conservative rule also preserves fabricated/stale orphan row numbers;
reconciliation cannot infer that their deletion was intentional.

Phantom redirection holds both endpoint page locks in sorted order through
fresh reads, transfer and removal. Current fact rows are locked in one DB
transaction and checked against actual fence state. Original identities,
including expired rows, move with the destination row numbers. Conflicting
deduplication, legacy history and page-local supersession references refuse.
A queued forget rechecks routing after acquiring its lock, releases that lock
before rerouting, and follows the original ID to the destination. The phantom
writer retains its native file replacement policy; arbitrary noncooperating
filesystem writers are outside that page-lock guarantee.

The v0.32.2 migration uses `stampLegacyFactsToFence` itself. It cannot bypass
lossless value checks, snapshots, native locks, missing-file refusal or
`GBRAIN_FACT_REPAIR=off`. It no longer creates missing stubs or independently
stamps lossy rows. It is not a recovery shortcut for a refused automatic repair.

## Offline rollback only

There is no supported automatic or online rollback. The old procedure
“unstamp, restore a path, sync while automatic repair can run” is unsafe and
must not be used. Neither an environment change in one shell nor holding the
page lock proves that every other producer is stopped.

An operator performing rollback must:

1. Disable repair/reconciliation with `GBRAIN_FACT_REPAIR=off` in **every**
   relevant process and stop all producers touching the source (serve sweep,
   cycle/job workers, sync, migration/backfill, CLI/API writes). Drain their in-flight operations
   and verify they have stopped before proceeding. The switch is checked by
   direct repair, reconciliation and phantom entry points and again before
   mutation; it does not itself stop or drain other processes.
2. With the source still quiescent, preserve the current file and DB evidence.
   Select the exact source, slug and fact IDs. Unstamp only those IDs inside a
   transaction. Never delete their fact rows or metadata.
3. Review/merge the previous fence state into the current file while preserving
   later edits. Do not blindly check out an old blob over human content. Any
   ambiguity stops rollback with the file and fact rows retained.
4. Sync that reviewed file while repair remains disabled and other producers
   remain stopped. Verify exact IDs/values/expiry state, file bytes and page
   cache. Only then may the operator re-enable processes.

`facts-repair-safety.test.ts` proves an in-flight repair is drained before work
proceeds, then injects a repair/reconciliation attempt **after unstamping**.
Disabled attempts do no work; later human bytes and legacy rows survive. This
is an isolated contract test, not evidence that production has been stopped.

## Verification and changed contracts

`test/facts-repair-lifecycle.test.ts` pins the revision, queued forget, migration,
search, crash reuse and full second/third/fourth-arrival contracts. The lifecycle
passes in both required temporary roots without positional insertion or a repair
commit. `test/facts-fence.test.ts` pins repeated-fence parsing, native
canonicalization and all-block privacy stripping.

`test/facts-repair-safety.test.ts` and `test/facts-repair-file.test.ts` cover the
independent byte/filter, commit, symlink, ownership, unavailable-target,
concurrent-forget, redirect-destination, metadata, precision, rollback and
maintenance-report failures. The file-boundary tests swap both directory and
file identities AFTER the final pre-write check; they check actual bytes.

Earlier tests/probes asserting automatic residue healing, automatic commits,
file replacement or resurrection of expired legacy facts describe removed
contracts. They are retained unchanged as historical regression evidence;
passing those assertions would now violate safety. The source-owned build
handoff lists the exact fresh results, including all remaining failing
assertions. A builder result is not independent acceptance or deployment.
