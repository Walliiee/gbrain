# Native lifecycle repair — branch preparation

Implemented in the isolated worktree. This is an internal review candidate;
production activation has not been performed.

- Base: `306ab2a09bf6c77687f5710cc93760ef2cb74494`.
- Branch: `fix/cos-native-lifecycle-20260914`.
- Implementation diff SHA-256: `9adff52bcf58230570cb5f6cbdb86d4f5f0ffb335027ad173f1bf739362aab54` (staged binary diff from
  the base, excluding this report and the supplied `BUILD-COS.md.orig`).
- The local commit containing this report is the handoff head; obtain its
  immutable ID with `git log -1 --format=%H -- BUILD-RESULT.md`.

## Root cause and implementation

Native candidate queries enforced source/visibility/deletion controls but did
not interpret `frontmatter.status`. The external governed wrapper separately
excluded statuses, so native CLI/MCP retrieval could return superseded pages.
Filtering only the final MCP response would also waste top-k slots and leave
other retrieval paths unprotected.

The new DB-plane key `search.exclude_statuses` accepts a validated JSON array
of strings. Missing configuration or `[]` preserves historical search behavior.
Both native engines resolve the serving brain's policy independently of query
parameters. Invalid configuration fails closed. Matching uses ASCII case
folding and surrounding ASCII whitespace trimming; missing/null/non-string
page statuses remain eligible. No status values are hardcoded as defaults.

The shared predicate applies before keyword, chunk-keyword, title, CJK, vector,
and fuzzy limits. Hybrid propagation covers aliases, exact identity source
probes, entity seeds, relational edges/origins, and optional code walks before
their caps. Existing grants, private-page restrictions, quarantine and deletion
checks remain in place. Explicit historical `get_page` retains its existing
access controls; search has no local or remote per-query historical opt-out.

Two adversarial findings were fixed during implementation:

1. HNSW can exhaust its approximate scan on excluded rows despite SQL `WHERE`
   preceding `LIMIT`. Configured lifecycle vector searches use exact distance
   ordering over eligible chunks and remove the HNSW pool ceiling. The
   unconfigured vector path remains unchanged.
2. Exact slug lookup previously chose the first source before lifecycle
   eligibility. Eligible sources are now selected before the five-source cap;
   a seven-source duplicate-slug fixture proves an active match survives.

An additional optional route is explicitly contained: automatic CRAG `think`
escalation uses independent takes/time-window readers. With a non-empty
lifecycle policy, requested automatic synthesis is skipped with
`retrieval.crag.think_skipped: "lifecycle_policy"`; filtered results and weak
confidence remain visible. Standalone `think` is outside this repair.

Cache identity includes the normalized exclusion set (epoch 29). Semantic
result reuse remains disabled as it was at the base. No migration, reindex,
embedding calls, package installation, or recurring automation was added.

## Files

- `src/core/search/lifecycle-policy.ts`, `src/core/types.ts`: typed policy,
  strict parser, normalization and SQL predicate.
- `src/commands/config.ts`, `src/core/config.ts`: validation and key discovery.
- `src/core/{pglite,postgres}-engine.ts`, `src/core/search/sql-ranking.ts`:
  native engine enforcement, CJK threading and exact configured vector scan.
- `src/core/search/{hybrid,mode,read-policy-sql,read-enrichment,exact-lookup,relational-recall,two-pass}.ts`
  and `src/core/entities/resolve.ts`: pipeline propagation and cache identity.
- `src/core/ops/search.ts`, `src/core/search/crag.ts`,
  `src/core/operations-descriptions.ts`: shared operation contract and explicit
  automatic-synthesis limitation.
- `test/search/*lifecycle*.test.ts`,
  `test/helpers/lifecycle-search-contract.ts`,
  `test/e2e/native-lifecycle-postgres.test.ts`, `test/search-mode.test.ts`:
  synthetic regression evidence and cache epoch assertions.
- `docs/guides/search-lifecycle.md`, `docs/architecture/KEY_FILES.md`,
  `scripts/e2e-test-map.ts`, `scripts/module-size-limits.tsv`: operator docs,
  test routing and visible size ceilings. The ceiling metadata also corrects
  an existing one-line `jobs.ts` overshoot at the base (3158 actual vs 3157
  ceiling); no `jobs.ts` code changed.

## Actual validation

All counts below are fresh executions, not summed unique coverage. Unit runs
unset database URL overrides and use the repository's isolated home/provider
preloads. Dependencies were absent here, so matching existing `node_modules`
were copied into this worktree using `cp -cR`; dependency declarations and
`bun.lock` were byte-equivalent. Nothing was installed or changed in the
source installation.

| Command | Actual result | Full local output |
|---|---|---|
| `bun test test/search/lifecycle-policy.test.ts test/search/native-lifecycle.test.ts` | 51 pass, 0 fail, 118 assertions | `.context/lifecycle-focused-tests.log` |
| `bun test test/search/lifecycle-policy.test.ts test/search/native-lifecycle.test.ts test/search/lifecycle-pipeline.test.ts test/relational-fanout.test.ts test/search-mode.test.ts test/two-pass.test.ts test/scripts/e2e-wiring.test.ts test/build-llms.test.ts` | 189 pass, 0 fail, 558 assertions | `.context/lifecycle-final-tests.log` |
| `bun test test/search/alias-hop.test.ts test/search/exact-lookup.test.ts test/search/searchvector-maxpool.test.ts test/search/searchvector-escalation.test.ts test/search/title-retrieval-arm.test.ts test/search/per-call-mode.test.ts test/config-set.test.ts test/operations-descriptions.test.ts` | 149 pass, 0 fail, 384 assertions | `.context/lifecycle-regression.log` |
| `bun test test/sql-ranking.test.ts` | 52 pass, 0 fail | `.context/lifecycle-sql-ranking.log` |
| `bun test test/e2e/native-lifecycle-postgres.test.ts` against the isolated cluster below | 28 pass, 0 fail, 85 assertions | `.context/lifecycle-postgres.log` |
| `bun run typecheck` | Exit 0, `tsc --noEmit` | `.context/lifecycle-check-typecheck.log` |

The focused engine contract proves a stronger historical candidate wins with
configuration absent, then active/missing-status rows fill the requested limit
with configuration enabled. It checks source grants, private/deleted pages,
malformed configuration, CJK fallback, local/remote shared operations,
keyword-only mode and historical get. The indexed vector fixture verifies the
HNSW index is selected by a control `EXPLAIN`, places 180 historical chunks
closer than the active page, and confirms configured search still returns that
active page at limit 1. Pipeline tests additionally check alias cap 3, source
probe cap 5, seed cap 10 and graph cap 50 with excluded candidates ahead of
eligible ones.

Postgres was **actually executed**, not merely skip-green. Docker was unavailable
(missing daemon socket). Installed PostgreSQL 17.10 and pgvector 0.8.2 were used
in a temporary cluster at `/private/tmp/gbrain-lifecycle-pg-81a2bdl4/data`,
loopback port 56778, database `gbrain_lifecycle_test`, role `lifecycle_test`.
The first sandbox attempt failed before startup on shared-memory allocation;
the authorized retry passed. Only that temporary database received test schema
initialization. `pg_ctl -D /private/tmp/gbrain-lifecycle-pg-81a2bdl4/data status`
after teardown returned `no server running`, exit 3, with no `postmaster.pid`.

For a new isolated test database, rerun with its explicit test-only URL:

```sh
GBRAIN_TEST_ALLOW_DATABASE_URL=1 DATABASE_URL="$LIFECYCLE_TEST_DATABASE_URL" \
  bun test test/e2e/native-lifecycle-postgres.test.ts
```

That test initializes schema and truncates its test database; it must never
target an operational database. The complete temporary-cluster setup and
teardown commands are preserved in the local Postgres receipt.

Additional checks passed: `check:module-size`, `check:engine-dynamic-import`,
`check:jsonb` (including positional AST scanner), `check:getpage-scope`,
`check:test-isolation`, `check:tool-catalog`, `check:doc-history`, E2E wiring,
and `git diff --check`. Documentation/catalog generation ran; their generated
outputs were already current. Full Docker CI, full unit/E2E corpus, live MCP
transport journeys and large-brain latency measurements were not run.

## Policy differences and parent activation

Read-only verification of the established wrapper found its actual
`exclude_statuses` array is `archived`, `superseded`, `retired`. Its runtime
checks that array; the eight-value list in the brief is not the current
status-only configuration. The implementation supports either list without
hardcoding either. It does not reproduce conditional `expires_at`,
canonical/generated exceptions, weights or Unicode case folding. Completed
and rejected statuses are weighted by the inspected wrapper, not universally
excluded. No live policy was changed.

Accountable parent reviews this branch and owns activation:

1. Review the code/report and the intended status list. To match the verified
   wrapper's status-only rule, use the three statuses below. A broader list
   intentionally changes that behavior.
2. Review latency risk: configured vector searches scan eligible vectors
   exactly. Existing query timeouts and bounded page-pool escalation remain;
   large-brain performance is unmeasured.
3. Through the separately authorized production release process, build/install
   the reviewed code into the intended native CLI/MCP runtime. No installation,
   restart, push or deployment was performed here.
4. On the intended brain, capture any prior setting, then configure and read
   it back:

   ```sh
   gbrain config set search.exclude_statuses '["archived","superseded","retired"]'
   gbrain config get search.exclude_statuses
   ```

5. Verify ordinary native CLI and actual MCP results on that runtime: an
   excluded high-score page must disappear, an eligible lower-score page must
   fill its slot, source/private protections must hold, and explicit historical
   get must remain authorized. Keep private reproduction identifiers out of
   public artifacts. Parent owns this activation proof; no coordination from
   the requester was required for branch preparation.

Rollback: restore the captured previous key value, or run
`gbrain config unset search.exclude_statuses` if it was absent. That returns
the prior native historical-search behavior immediately, including automatic
CRAG synthesis eligibility and normal HNSW selection. The patch changes no
schema or stored page content; code rollback can use the recorded base through
the normal release process.

## Adversarial completion check

| Strict done-condition | Verdict and re-runnable evidence |
|---|---|
| Real native engine filtering exists before limits, on both engines | **CONFIRMED** — actual engine suites above pass, including dominant historical and forced-index controls; source files reopened after edits. |
| Caller parameters cannot weaken operator configuration; prior access boundaries survive | **CONFIRMED** — shared operation contract tests pass for local, remote and granted contexts, including attempted historical/empty-exclusion parameters and denied foreign source. |
| Optional configuration absent preserves the existing search contract | **CONFIRMED** — each engine leg tests absent versus empty policy; existing retrieval regressions pass. |
| Historical explicit reads and cache separation are deliberate | **CONFIRMED** — historical get and normalized/different cache-key assertions pass. |
| Temporary test infrastructure is shut down | **CONFIRMED** — fresh `pg_ctl ... status` → `no server running`, exit 3; PID file absent. |
| Full release and live-runtime acceptance have passed | **UNVERIFIABLE / not claimed** — no release or live activation was performed; parent requirements are listed above. |
| All broader wrapper/think semantics and large-brain performance match | **UNVERIFIABLE / not claimed** — explicit limitations above; no full-parity or latency claim. |

Final verification after the last operation change:

- `bun test test/search/crag-query-op.test.ts test/search/lifecycle-crag.test.ts`
  → **9 pass, 0 fail, 58 assertions** (`.context/lifecycle-crag-regression.log`).
  The new regression proves automatic synthesis never calls takes or the
  date-window floor under this policy, and absent policy still performs its
  real keyless gather. This closes a reproduced historical-evidence bypass.
- `bun test test/search/crag-escalation-limit.serial.test.ts` → **5 pass,
  0 fail, 37 assertions** (`.context/lifecycle-crag-limit.log`).
- `bun test test/search/lifecycle-pipeline.test.ts` after the final exact-lookup
  error-path adjustment → **8 pass, 0 fail**.
- `bun run typecheck` → **exit 0** (`.context/lifecycle-typecheck-final.log`).
- `bun run check:module-size` → **exit 0**, ceilings satisfied
  (`.context/lifecycle-module-final.log`); `git diff --check` → **exit 0**.

The implementation hash can be regenerated after commit with:

```sh
git diff --binary 306ab2a09bf6c77687f5710cc93760ef2cb74494 HEAD -- . \
  ':!BUILD-RESULT.md' ':!BUILD-COS.md.orig' | shasum -a 256
```

**CONFIRMED:** no unresolved refuted completion claim remains within branch
preparation. **UNVERIFIABLE / not claimed:** live activation, full CI and
large-brain performance. Next action: accountable parent reviews the local
commit and runs the separately authorized activation proof above.
