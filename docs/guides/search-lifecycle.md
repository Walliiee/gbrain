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

When the exclusion list is non-empty, vector retrieval uses an exact distance
sort over eligible chunks. HNSW can apply page filters after its approximate
candidate scan and otherwise return nothing when excluded pages fill that
scan. Exact selection prevents that lifecycle starvation, at a potential
latency cost on large brains; the existing query timeout and bounded per-page
pool expansion still apply. With an empty or absent list the existing vector
index behavior is unchanged.

This setting does not implement conditional `expires_at` rules, canonical or
generated-record exceptions, status weights, source weights, or other ranking
policies used by an external wrapper. It does not infer lifecycle from titles,
slugs, task completion fields, or supersession links.
