import { afterAll, beforeAll, describe } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { lifecycleSearchContract, seedLifecycleCorpus } from '../helpers/lifecycle-search-contract.ts';

// Never loads .env.testing, operator config or an implicit live database.
const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('native lifecycle search contract (Postgres)', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl!, poolSize: 1 });
    await engine.initSchema();
    await engine.executeRaw('TRUNCATE pages, config CASCADE');
    await seedLifecycleCorpus(engine);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  lifecycleSearchContract(() => engine);
});
