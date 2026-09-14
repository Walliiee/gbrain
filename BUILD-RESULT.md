# Native lifecycle repair — tested branch revision

This revision addresses all three findings against `2451ed4e923f5082f8210a293d373677e01d13d3` in the isolated worktree. It is an internal review candidate. No live policy, data, runtime or deployment was changed.

- Branch: `fix/cos-native-lifecycle-20260914`.
- Original implementation base: `306ab2a09bf6c77687f5710cc93760ef2cb74494`.
- Revision base: `2451ed4e923f5082f8210a293d373677e01d13d3`.
- Revision implementation diff SHA-256: `b68fb259b25c3945d5447bb594a1ebfc7f123168c028b6dd63d69772d82fdf79` (binary diff from the revision base, excluding this report and supplied `.orig` briefs).
- Obtain the local handoff commit with `git log -1 --format=%H -- BUILD-RESULT.md`.

## Fixes

1. **Source-qualified alias identity.** A federated `sourceIds` grant previously overrode the current source's scalar during alias lookup. Reducing those results to bare slugs could attach B's alias to the same slug in A, fabricating A's relationship. Resolution now checks membership in the grant, narrows each query to its current source before candidate limits, and validates alias-hit and live-page source IDs before extracting slugs. Real PGLite tests cover overlapping slugs, B-only aliases, stronger B fuzzy/prefix candidates, ambiguity, invalid/unknown sources and outside-grant requests, with lifecycle configured and absent.
2. **DB-effective configuration readback.** `config get search.exclude_statuses` now reads the DB plane exclusively. An absent row prints `[]`; stderr states that file values are ignored. Real temporary config files and PGLite verify flat/nested file disagreement, DB absence, explicit empty/raw readback and matching values against the actual policy resolver and search results. Unrelated config keys retain their existing precedence.
3. **ANN first, exact fallback when underfilled.** Both engines keep index-compatible distance ordering and eligibility predicates in the normal query. Configured short/zero pages retry within the existing bounded ANN expansion. Only an underfilled distinct-page window triggers one exact pass over all eligible chunks, then best-per-page collapse and pagination. Both passes share the SQL predicates and access scope. Unlimited eligible chunks in the fallback prevent one dense page from consuming a second cap. A full ANN page never invokes exact fallback. Empty/absent configuration preserves the previous vector path. Cache epoch advances to 30 because candidates can differ from the previous unconditional exact path.

The maintained guide and architecture reference now describe conditional fallback, DB readback and the deliberate CRAG boundary. The E2E map includes both shared lifecycle contracts. The module-size ratchet changes only the three enlarged existing modules in this revision.

## Retained lifecycle contract

`search.exclude_statuses` is an optional, validated JSON string array stored in the serving brain's DB. Missing/empty policy excludes no statuses; malformed policy fails closed. Matching trims/folds ASCII, and missing/null/non-string page statuses stay eligible. No status defaults are hardcoded. Native keyword, chunk-keyword, CJK, title, vector and fuzzy candidates are filtered before limits; hybrid passes the policy into identity, alias and graph readers. Source grants, visibility and deletion checks remain active. Explicit historical `get_page` remains available under its existing access controls, with no search-query opt-out.

With a nonempty policy, automatic CRAG `think` is deliberately skipped and reports `retrieval.crag.think_skipped: "lifecycle_policy"`. Its separate evidence readers have not been made lifecycle-aware. Standalone `think` remains outside this repair. The setting does not replicate the wrapper's conditional expiry, canonical/generated exceptions, weights or Unicode folding.

## Fresh execution evidence

Each row is an actual execution in this revision, not a sum of unique tests. Unit commands unset `DATABASE_URL`, `GBRAIN_DATABASE_URL`, `GBRAIN_HOME` and `GBRAIN_CONFIG`; repository preloads isolate the home and disable paid provider discovery. Validation used installed dependencies and no provider credentials; nothing was installed.

| Command | Actual result | Local evidence |
|---|---|---|
| Focused/regression command below | 370 pass, 0 fail, 1,022 assertions across 19 files | `.context/fix-cos-regression.log` |
| `bun test test/search/native-lifecycle.test.ts test/search/lifecycle-federated-alias.test.ts test/search/lifecycle-config-readback.test.ts` | 47 pass, 0 fail, 225 assertions | `.context/fix-cos-final-focused.log` |
| Independent rerun: `bun test test/search/native-lifecycle.test.ts` | 32 pass, 0 fail, 144 assertions | `.context/fix-cos-adversarial.log` |
| `bun test test/e2e/native-lifecycle-postgres.test.ts` with the explicit isolated test URL | 32 pass, 0 fail, 144 assertions | `.context/fix-cos-postgres.log` |
| `bun test test/scripts/e2e-wiring.test.ts` | 11 pass, 0 fail, 28 assertions | `.context/fix-cos-e2e-wiring.log` |
| `bun run typecheck` | Exit 0, `tsc --noEmit` | `.context/fix-cos-typecheck-final.log` |

```sh
env -u DATABASE_URL -u GBRAIN_DATABASE_URL -u GBRAIN_HOME -u GBRAIN_CONFIG \
  bun test test/search/lifecycle-policy.test.ts \
  test/search/lifecycle-pipeline.test.ts test/search/lifecycle-federated-alias.test.ts \
  test/search/lifecycle-config-readback.test.ts test/search/lifecycle-crag.test.ts \
  test/search/crag-query-op.test.ts test/config-get-plane.test.ts test/config-set.test.ts \
  test/entity-resolve.test.ts test/entity-resolve-prefix-dirs.test.ts \
  test/relational-recall.test.ts test/search/alias-hop.test.ts test/search/exact-lookup.test.ts \
  test/search/searchvector-escalation.test.ts test/search/searchvector-maxpool.test.ts \
  test/search-mode.test.ts test/two-pass.test.ts test/sql-ranking.test.ts test/build-llms.test.ts
```

Eight relevant guards passed: `check:module-size`, `check:engine-dynamic-import`, `check:jsonb`, `check:getpage-scope`, `check:test-isolation`, `check:source-id-projection`, `check:doc-history`, `check:tool-catalog`. Their actual outputs are `.context/fix-cos-check-*.log`; the isolation guard scanned 1,672 non-serial unit files. `bun run build:llms` ran; generated outputs were already current. Final whitespace/index verification is recorded below.

The shared vector contract observes the actual engine query, bindings, plan and returned rows while still executing the real database. Fixture-only planner controls force HNSW selection so small synthetic data cannot silently test a sequential join instead. The nonmatching-policy case returns ten rows using HNSW without exact fallback. Dense excluded neighbors exercise zero ANN rows; a 1,100-chunk eligible page also exercises short pools and pagination after the approximate neighborhood is exhausted. Exact fallback returns distinct eligible pages despite that density, and source/private/deleted decoys remain excluded in every observed pass. This proves the query path under the stated planner controls, not production planner preference or latency.

Shared operation tests cover the CLI/MCP operation implementation through lexical arms in a keyless environment; their vector arm can be unavailable. Direct engine tests separately prove actual vector execution. This is not physical CLI/MCP transport proof. The parent-owned `.context/parent-native-transport.test.ts` was not modified.

Real PostgreSQL 17.10 with pgvector 0.8.2 ran in a fresh task-owned cluster at `/private/tmp/gbrain-fix-cos-pg-fn8mkgpl/data`, loopback port 60987, database `gbrain_lifecycle_test`, role `lifecycle_test`, with pool size one and an isolated home. The command, server output, test output and teardown are preserved in `.context/fix-cos-postgres.log`. After testing, `pg_ctl ... status` returned `no server running` (exit 3), then only the owned temporary directory was removed. An independent final check confirmed the directory is absent and connecting to its port returns error 61 (connection refused).

To repeat against a newly created disposable test database, supply its explicit URL (the suite initializes schema and truncates its own test database):

```sh
GBRAIN_TEST_ALLOW_DATABASE_URL=1 DATABASE_URL="$LIFECYCLE_TEST_DATABASE_URL" \
  bun test test/e2e/native-lifecycle-postgres.test.ts
```

The final adversarial rerun also passed all 47 alias/config/native PGLite tests after the last fixture correction. An independent agent reopened both engine paths, checked query parameters and the config file path, then reran the native suite: 32 pass, 0 fail. No actionable finding remains in that bounded review.

Failure evidence is preserved, not overwritten:

- `.context/fix1-before.log`: temporary copies of the revision-base resolver reproduce false A relationships with lifecycle absent and configured (6 pass, 4 fail); the temporary source/test copies were removed. `.context/fix1-after.log` has 83 pass, 0 fail after correction.
- `.context/fix-cos-vector-contract.log`: initial vector fixture plans chose a non-HNSW join despite disabling sequential scans, so index assertions correctly failed. Fixture controls were tightened. The later 1,100-chunk fixture exposed an overly strict test assertion: a legitimate first ANN attempt can return zero before later attempts return one. The assertion now allows earlier zero attempts while requiring a short nonempty attempt and validating every returned identity. Final fresh checks exercise the corrected fixture.

## Adversarial completion check

Each condition was checked against actual files or commands after the changes; previous status messages were not used as proof.

| Strict done-condition and attempt to refute it | Verdict and re-runnable evidence |
|---|---|
| A B-only alias cannot create A's relationship, and stronger B candidates cannot consume A's limit | **CONFIRMED** — `bun test test/search/lifecycle-federated-alias.test.ts` scenarios passed in the 370-test run; the original false attribution was reproduced before the fix. `resolve.ts` was reopened to verify both grant narrowing and result-source validation. |
| With a real conflicting file or no DB row, readback and actual retrieval agree on the DB policy | **CONFIRMED** — `bun test test/search/lifecycle-config-readback.test.ts` passes all five cases in the regression run. The fixture path was checked against the actual `configDir()`/`configPath()` implementation. |
| Configuring a nonmatching exclusion does not itself force exact scan; zero/short ANN can still fill the requested unique-page window safely | **CONFIRMED** — the final focused command above → `47 pass / 0 fail`; the isolated PostgreSQL command → `32 pass / 0 fail`. Actual plans show normal `ANN / hnsw: true / rows: 10` with no exact query; exhausted ANN phases then show `exact / hnsw: false / rows: 2` (or 3), with an unlimited eligible pool. Both engine bodies and final assertions were reopened. |
| Type safety, relevant guards and unchanged retrieval regressions pass | **CONFIRMED** — `bun run typecheck` → exit 0; eight guards → exit 0; regression command → `370 pass / 0 fail`. |
| Temporary database resources are shut down and removed | **CONFIRMED** — `pg_ctl -D /private/tmp/gbrain-fix-cos-pg-fn8mkgpl/data status` before removal → `no server running`, exit 3. After cleanup, `test ! -e /private/tmp/gbrain-fix-cos-pg-fn8mkgpl` → exit 0; a socket probe to `127.0.0.1:60987` → connection refused. |
| Changed files are reviewable without whitespace errors | **CONFIRMED** — `git diff --check` → exit 0; the explicit file list was inspected before staging. The commit hash and post-commit state are checked separately in the final handoff. |
| Full CI, live activation, physical CLI/MCP acceptance, standalone think parity or production-scale latency passed | **UNVERIFIABLE / not claimed** — none was performed by this revision. |

## Activation and rollback boundary

The accountable parent reviews this committed revision and owns any separately authorized release/activation. Review the desired status list, release into the intended native CLI/MCP runtime, capture the prior DB key, set the approved list, and read back the DB-effective value. On that runtime, prove an excluded dominant result disappears, eligible results fill its slot, grants/private protections hold, and authorized historical get remains available. This branch adds no schema migration or page-content rewrite.

A status-only example from the original branch preparation is `["archived","superseded","retired"]`; the revision did not re-audit or alter any operational policy. The chosen production list remains the parent's activation decision. Restore the captured DB value to roll back policy, or `gbrain config unset search.exclude_statuses` if it was previously absent. That restores native search without lifecycle exclusions, including automatic CRAG eligibility. Code rollback follows the normal release process.

Remaining risks: exact fallback can be costly on large brains, though full ANN pages avoid it; production latency and planner choice are unmeasured. Existing query timeouts remain, and PostgreSQL imposes its existing eight-second statement timeout per vector attempt. Full CI and live-runtime acceptance remain separate from this tested branch preparation.

Regenerate the revision implementation hash after commit with:

```sh
git diff --binary 2451ed4e923f5082f8210a293d373677e01d13d3 HEAD -- . \
  ':!BUILD-RESULT.md' ':!*.orig' | shasum -a 256
```
