/** Per-source entity identity remains source-qualified throughout federation. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resolveEntitySlugWithSource } from '../../src/core/entities/resolve.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { resolveSearchLifecyclePolicy } from '../../src/core/search/lifecycle-policy.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('src-a', 'Source A'), ('src-b', 'Source B'), ('foreign', 'Foreign')");
});

async function page(sourceId: string, slug: string, title = 'Unrelated synthetic entity') {
  await engine.putPage(slug, { type: 'company', title, compiled_truth: 'Synthetic federation fixture.' }, { sourceId });
}

for (const configured of [false, true]) {
  describe(`federated entity resolution with lifecycle ${configured ? 'configured' : 'absent'}`, () => {
    async function policy() {
      if (configured) await engine.setConfig('search.exclude_statuses', '["superseded"]');
      const lifecycle = await resolveSearchLifecyclePolicy(engine);
      expect(lifecycle.excludeStatuses).toEqual(configured ? ['superseded'] : []);
      return { ...lifecycle, sourceIds: ['src-a', 'src-b'], sourceId: 'foreign' };
    }

    test('an alias declared only in B never resolves the same slug or its investors in A', async () => {
      for (const sourceId of ['src-a', 'src-b', 'foreign']) {
        await page(sourceId, 'companies/shared-company');
        await page(sourceId, `people/investor-${sourceId}`);
        await engine.addLink(`people/investor-${sourceId}`, 'companies/shared-company', '', 'invested_in', 'manual', undefined, undefined,
          { fromSourceId: sourceId, toSourceId: sourceId });
      }
      await engine.setPageAliases('companies/shared-company', 'src-b', ['blue umbrella']);
      await engine.setPageAliases('companies/shared-company', 'foreign', ['blue umbrella']);
      const opts = await policy();
      const query = 'who invested in blue umbrella';
      const a = await buildRelationalArm(engine, query, { ...opts, sourceIds: ['src-a'] });
      const b = await buildRelationalArm(engine, query, { ...opts, sourceIds: ['src-b'] });
      expect(a).toEqual([]);
      expect(b.map(row => [row.source_id, row.slug])).toEqual([['src-b', 'people/investor-src-b']]);
      const federated = await buildRelationalArm(engine, query, opts);
      expect(federated.map(row => [row.source_id, row.slug])).toEqual([['src-b', 'people/investor-src-b']]);
      expect((await resolveEntitySlugWithSource(engine, 'src-a', 'blue umbrella', opts))?.source).toBe('fallback_slugify');
      expect((await resolveEntitySlugWithSource(engine, 'src-b', 'blue umbrella', opts))?.source).toBe('alias_exact');
    });

    test('B alias collisions cannot veto the sole A alias before uniqueness', async () => {
      await page('src-a', 'companies/a-target');
      await engine.setPageAliases('companies/a-target', 'src-a', ['quiet meadow']);
      for (let i = 0; i < 12; i++) {
        const slug = `companies/b-target-${i}`;
        await page('src-b', slug);
        await engine.setPageAliases(slug, 'src-b', ['quiet meadow']);
      }
      const opts = await policy();
      expect((await engine.resolveAliases(['quiet meadow'], opts)).get('quiet meadow')).toHaveLength(13);
      expect(await resolveEntitySlugWithSource(engine, 'src-a', 'quiet meadow', opts)).toEqual({ slug: 'companies/a-target', source: 'alias_exact' });
      expect((await resolveEntitySlugWithSource(engine, 'src-b', 'quiet meadow', opts))?.source).toBe('fallback_slugify');
    });

    test('stronger B fuzzy matches cannot consume A candidate limits', async () => {
      await page('src-a', 'companies/a-canonical', 'Synthetic Venture');
      for (let i = 0; i < 5; i++) await page('src-b', `companies/b-strong-${i}`, 'Synthetic Ventures');
      const opts = await policy();
      const leaders = await engine.executeRaw<{ source_id: string }>(
        `SELECT source_id FROM pages WHERE source_id = ANY($1::text[])
         ORDER BY similarity(lower(title), $2) DESC, slug LIMIT 3`,
        [opts.sourceIds, 'synthetic ventures'],
      );
      expect(leaders.map(row => row.source_id)).toEqual(['src-b', 'src-b', 'src-b']);
      expect(await resolveEntitySlugWithSource(engine, 'src-a', 'Synthetic Ventures', opts)).toEqual({ slug: 'companies/a-canonical', source: 'fuzzy_match' });
      expect((await resolveEntitySlugWithSource(engine, 'src-b', 'Synthetic Ventures', opts))?.slug).toMatch(/^companies\/b-strong-/);
    });

    test('B prefix candidates cannot consume A prefix limit or ambiguity decision', async () => {
      await page('src-a', 'people/cedar-target');
      for (let i = 0; i < 12; i++) await page('src-b', `people/cedar-${i}`);
      const opts = await policy();
      expect(await resolveEntitySlugWithSource(engine, 'src-a', 'Cedar', opts)).toEqual({ slug: 'people/cedar-target', source: 'fuzzy_match' });
      expect((await resolveEntitySlugWithSource(engine, 'src-b', 'Cedar', opts))?.source).toBe('fallback_slugify');
    });

    test('unknown, invalid, and outside-grant sources cannot resolve aliases or real pages', async () => {
      await page('foreign', 'companies/foreign-only');
      await engine.setPageAliases('companies/foreign-only', 'foreign', ['blue umbrella']);
      const opts = await policy();
      expect(await resolveEntitySlugWithSource(engine, 'foreign', 'blue umbrella', opts)).toBeNull();
      expect(await resolveEntitySlugWithSource(engine, 'foreign', 'companies/foreign-only', opts)).toBeNull();
      expect(await resolveEntitySlugWithSource(engine, 'unknown', 'blue umbrella', opts)).toBeNull();
      expect(await resolveEntitySlugWithSource(engine, '__all__', 'blue umbrella', { ...opts, sourceIds: ['__all__'] })).toBeNull();
      const unknown = await resolveEntitySlugWithSource(engine, 'unknown', 'blue umbrella', { ...opts, sourceIds: ['unknown'] });
      expect(unknown?.source).toBe('fallback_slugify');
      expect(await buildRelationalArm(engine, 'who invested in blue umbrella', { ...opts, sourceIds: ['unknown'] })).toEqual([]);
      expect(await resolveEntitySlugWithSource(engine, 'foreign', 'blue umbrella', { excludeStatuses: opts.excludeStatuses, sourceId: 'src-a' })).toBeNull();
    });
  });
}
