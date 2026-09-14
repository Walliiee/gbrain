import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { lifecycleSearchContract, seedLifecycleCorpus } from '../helpers/lifecycle-search-contract.ts';

describe('native lifecycle search contract (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seedLifecycleCorpus(engine);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  lifecycleSearchContract(() => engine);
});
