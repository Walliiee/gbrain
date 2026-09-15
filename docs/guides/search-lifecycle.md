# Search lifecycle exclusions

`search.exclude_statuses` is an optional **DB-plane, per-brain** setting. It
removes pages with matching `frontmatter.status` from native search candidate
selection before ranking and result limits. CLI and MCP use the same policy,
including keyword-only search. There are no default excluded statuses: an
absent key or `[]` preserves the existing historical-search behavior.

For example, on the intended brain:

```sh
gbrain config set search.exclude_statuses '["archived","superseded","retired"]'
gbrain config get search.exclude_statuses
```

Readback reports the DB-effective value. If the DB row is absent it reports
`[]`; any value for this key in `config.json` is ignored, including when no DB
value exists. The CLI explains that precedence on stderr.

The value must be a JSON array of non-empty strings without NUL. Configuration
writes validate it; malformed stored values cause retrieval to fail rather
than silently disabling the policy. Identifiers match after ASCII case folding
and trimming ASCII whitespace (space, tab, newline, carriage return, form feed,
vertical tab). Missing, null, and non-string page statuses remain eligible.
Duplicates and order do not affect the policy or query-cache identity. Unicode
case folding is not performed. For example `" SUPERSEDED "` matches
`"superseded"`.

Every operator chooses their own lifecycle vocabulary. A broader example is
`["archived","superseded","expired","retired","completed","complete","done","rejected"]`.
This list is an example, not a built-in default.

The policy covers keyword, chunk-keyword, title, CJK fallback, vector (including
image vectors), fuzzy slug resolution, and hybrid alias, exact-identity,
relational, and code-walk retrieval. It is additive to source grants, page
visibility, quarantine, protected-body, and soft-delete checks. A historical
query, high detail, or caller-supplied unknown parameter cannot disable it.
There is no per-query opt-out, even for the trusted CLI. Use an explicit
`get_page` / CLI `get` with a known source and slug for historical inspection;
that read retains its own access checks. This is search selection, not an
authorization boundary that revokes access to historical documents.

When this policy is active, `query` does not automatically escalate weak
results into `think`: its independent takes and time-window readers do not
implement this search policy. The response explicitly reports
`retrieval.crag.think_skipped: "lifecycle_policy"` when such an escalation was
requested. Filtered results and weak-confidence reporting remain available.
Standalone `think`, takes, trajectory, and explicit list/get operations keep
their own existing contracts; this setting does not promise lifecycle parity
for those surfaces.

To restore prior search behavior, remove only this key:

```sh
gbrain config unset search.exclude_statuses
```

No migration, reindex, embedding regeneration, or background job is needed.
Each retrieval reads the serving brain's current setting. Semantic result
reuse is currently disabled; the retained cache identity includes the resolved
status set so different policies cannot share a cache entry if reuse returns.

Vector retrieval keeps indexed approximate nearest-neighbor (ANN) search as
its normal path, with the same lifecycle, source and visibility predicates
inside candidate selection. With exclusions configured, a short or empty page
triggers bounded ANN expansion (at most three retries, with the HNSW pool
ceiling unchanged). If the resulting unique pages still cannot satisfy
`offset + limit`, one exact fallback scans all eligible chunks and collapses
them by page before pagination. It uses the same predicates and access scope.
A full ANN result never pays for an exact fallback, including when the
configured exclusions match no pages. Empty or absent configuration preserves
the previous vector behavior. Fallback latency on large brains is unmeasured;
existing query timeouts still apply.

`test/e2e/native-lifecycle-transport.test.ts` exercises real CLI processes and stdio MCP against a fresh, keyless PGLite brain: an unconfigured historical control, DB/file readback disagreement, filtered top-k, private/source scope, ignored caller overrides, explicit historical get, invalid configuration, and rollback. It removes its temporary home and inherits no operator database URL or provider credentials. This transport test is lexical; the shared native-engine contracts separately exercise real vectors and PostgreSQL.

This setting does not implement conditional `expires_at` rules, canonical or
generated-record exceptions, status weights, source weights, or other ranking
policies used by an external wrapper. It does not infer lifecycle from titles,
slugs, task completion fields, or supersession links.
