/** Round 8 corrective contracts. Isolated engines/files; no providers.
 * The full later-arrival lifecycle is deliberately retained as a required
 * outcome even while the append-only repair cannot safely fulfil it. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from '../test/helpers/reset-pglite.ts';
import { withEnv } from '../test/helpers/with-env.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { repairLegacyRowsForSource, type LegacyStampHooks } from '../src/core/facts/fence-legacy.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { __testing as migration } from '../src/commands/migrations/v0_32_2.ts';

const SOURCE = 'repair-fixture'; const SLUG = 'people/example-person';
const ORIGINAL = '---\ntype: person\ntitle: Example\n---\n\n# Example\n\nKeep every byte.\n';
let engine: PGLiteEngine; let root: string; let repo: string; let home: string; let file: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const repair = (hooks?: LegacyStampHooks) => isolated(() => repairLegacyRowsForSource(engine, { sourceId: SOURCE, hooks }));
const extract = (o = {}) => isolated(() => runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG], ...o }));
const ctx = (remote: boolean) => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: SOURCE }) as unknown as OperationContext;
const op = (name: string) => operations.find(o => o.name === name)!;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(import.meta.dir, 'fixture-')); repo = join(root, 'repo'); home = join(root, 'home'); file = join(repo, `${SLUG}.md`);
  mkdirSync(join(repo, 'people'), { recursive: true }); writeFileSync(file, ORIGINAL);
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'fixture');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, repo]);
  await isolated(() => importFromContent(engine, SLUG, ORIGINAL, { sourceId: SOURCE, noEmbed: true }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function seed(claim = 'Keep this fact', visibility: 'private' | 'world' = 'private', slug = SLUG) {
  const r = await engine.executeRaw<{ id: string }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,confidence)
    VALUES($1,$2,$3,'fact',$4,'medium','2026-01-02T00:00:00Z','api:fixture',0.9) RETURNING id::text`, [SOURCE, slug, claim, visibility]);
  return r[0]!.id;
}
const rows = () => engine.executeRaw<{ id: string; row_num: number | null; expired: boolean; fact: string }>('SELECT id::text, row_num, expired_at IS NOT NULL AS expired, fact FROM facts WHERE source_id=$1 ORDER BY id', [SOURCE]);
async function sync(slug = SLUG, path = file) { const p = parseMarkdown(readFileSync(path, 'utf8'), `${slug}.md`); await engine.refreshPageBody(slug, SOURCE, p.compiled_truth, p.timeline, 'fixture-sync'); }
const chunkHits = (needle: string) => engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND cc.chunk_text LIKE $2`, [SOURCE, `%${needle}%`]);

import { openRepairFile, strictUtf8 } from '../src/core/facts/repair-file.ts';
import { stripFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { linkSync, symlinkSync, openSync, writeSync, closeSync } from 'node:fs';

async function pair(firstVisibility: 'world'|'private'='world', secondVisibility: 'world'|'private'='world') {
 const one=await seed('Originalfirstquartz',firstVisibility); expect((await repair()).rowsStamped).toBe(1);
 const two=await seed('Originsecondquartz',secondVisibility); expect((await repair()).rowsStamped).toBe(1);
 return [one,two];
}
for(const index of [0,1]) test(`FORGET repeated fence target block ${index+1}: observe actual expiry after reconciliation`,async()=>{
 const ids=await pair();const before=readFileSync(file); const f=await isolated(()=>forgetFactInFence(engine,Number(ids[index])));
 const justForgot=await rows();const after=readFileSync(file);await sync(); const r=await extract();
 const final=await rows(); console.log('FORGET_REPEATED',JSON.stringify({index,ids,f,justForgot,fileUnchanged:before.equals(after),rec:r,final}));
 expect(f.ok).toBe(true);expect(justForgot[index]!.expired).toBe(true);
 // Acceptance: forgetting must remain effective through the next normal cycle.
 expect(final.some(x=>x.fact===justForgot[index]!.fact && !x.expired)).toBe(false);
});

test('NEIGHBOUR: one refused dirty page must not starve a healthy page',async()=>{
 await pair(); const dirty=readFileSync(file,'utf8')+'\nHuman review in progress.\n';writeFileSync(file,dirty); await seed('Thirdpending');
 const neighbor='people/healthy-neighbor';const b=upsertFactRow(ORIGINAL,{claim:'Healthyneighbourclaim',kind:'fact',confidence:0.9,visibility:'world',notability:'medium',validFrom:'2026-01-02',source:'api:fixture'}).body;
 writeFileSync(join(repo,neighbor+'.md'),b);await isolated(()=>importFromContent(engine,neighbor,b,{sourceId:SOURCE,noEmbed:true}));git('add','--',neighbor+'.md');git('commit','-qm','neighbor fixture');
 const r=await extract({slugs:[SLUG,neighbor]});const nr=await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND entity_slug=$2',[SOURCE,neighbor]);
 console.log('REFUSED_NEIGHBOUR',JSON.stringify({r,neighborRows:nr,humanPreserved:readFileSync(file,'utf8')===dirty}));
 expect(readFileSync(file,'utf8')).toBe(dirty);expect(nr.length).toBe(1);
});

test('PHANTOM origin has two repair fences: remains eligible for redirect',async()=>{
 const ph='example';const ppath=join(repo,ph+'.md');writeFileSync(ppath,'# Example\n');await isolated(()=>importFromContent(engine,ph,'# Example\n',{sourceId:SOURCE,noEmbed:true}));git('add','--',ph+'.md');git('commit','-qm','phantom');
 const one=await seed('Phantomfirst','world',ph);expect((await repair()).rowsStamped).toBe(1);const two=await seed('Phantomsecond','world',ph);expect((await repair()).rowsStamped).toBe(1);
 const r=await isolated(()=>runExtractFacts(engine,{sourceId:SOURCE,brainDir:repo,slugs:[ph,SLUG]}));
 const final=await engine.executeRaw('SELECT id::text,entity_slug,row_num,expired_at FROM facts WHERE source_id=$1 ORDER BY id',[SOURCE]);console.log('PHANTOM_TWO_ORIGIN',JSON.stringify({one,two,r,final}));expect(r.phantomsRedirected).toBe(1);
});

test('PHANTOM destination has two fences: redirect must retain one unambiguous row stream',async()=>{
 await pair();const ph='example';const ppath=join(repo,ph+'.md');writeFileSync(ppath,'# Example\n');await isolated(()=>importFromContent(engine,ph,'# Example\n',{sourceId:SOURCE,noEmbed:true}));git('add','--',ph+'.md');git('commit','-qm','phantom');
 const id=await seed('Phantomthird','world',ph);expect((await repair()).rowsStamped).toBe(1);
 const r=await isolated(()=>runExtractFacts(engine,{sourceId:SOURCE,brainDir:repo,slugs:[ph,SLUG]}));const parsed=parseFactsFence(readFileSync(file,'utf8'));
 console.log('PHANTOM_TWO_DEST',JSON.stringify({id,r,parsed,rows:await rows()}));expect(parsed.warnings).toEqual([]);expect(r.phantomsRedirected).toBe(1);
});

test('REMOTE save two mixed fences preserves privacy and parses after actual get/edit/put',async()=>{
 await pair('private','world');const before=await rows();await isolated(async()=>{
 const got=await op('get_page').handler(ctx(true),{slug:SLUG,include_content:true}) as any;expect(got.content).not.toContain('Originalfirstquartz');
 const save=await op('put_page').handler(ctx(true),{slug:SLUG,content:got.content.replace('Keep every byte.','A human revision.'),base_revision:got.revision});
 const p=parseFactsFence(readFileSync(file,'utf8'));const r=await extract();const later=await op('get_page').handler(ctx(true),{slug:SLUG,include_content:true}) as any;
 console.log('REMOTE_TWO',JSON.stringify({save,p,r,before,after:await rows(),secretInRemote:later.content.includes('Originalfirstquartz'),secretChunks:await chunkHits('Originalfirstquartz')}));
 expect(later.content).not.toContain('Originalfirstquartz');expect(await chunkHits('Originalfirstquartz')).toEqual([{n:0}]);
 const save2=await op('put_page').handler(ctx(true),{slug:SLUG,content:later.content.replace('A human revision.','A second human revision.'),base_revision:later.revision});const body2=readFileSync(file,'utf8');const rec2=await extract();
 console.log('REMOTE_TWO_SECOND_SAVE',JSON.stringify({save2,privateFilePreserved:body2.includes('Originalfirstquartz'),rec2,rows:await rows()}));
 expect(body2).toContain('Originalfirstquartz');expect(p.warnings).toEqual([]);
 });
});

for(const location of ['prose','first-row'])test(`R7-3 same-inode human edit during planning: ${location} preserved`,async()=>{
 await seed('Originalfirstquartz','world');expect((await repair()).rowsStamped).toBe(1);const id=await seed('Secondpending');const before=readFileSync(file,'utf8');const originalText=location==='prose'?'Keep every byte.':'Originalfirstquartz';const replacement=location==='prose'?'Save human byte.':'Editedfirsthuman';const human=before.replace(originalText,replacement.padEnd(originalText.length,'!'));
 const r=await repair({beforeRename:()=>{const fd=openSync(file,'r+');writeSync(fd,Buffer.from(human),0,Buffer.byteLength(human),0);closeSync(fd);}});
 console.log('HUMAN_PLANNING',JSON.stringify({location,r,humanPreserved:readFileSync(file,'utf8')===human,rows:await rows()}));expect(r.rowsStamped).toBe(0);expect(readFileSync(file,'utf8')).toBe(human);expect((await rows()).find(x=>x.id===id)?.row_num).toBeNull();
});

for(const mutation of ['in-place','symlink','hardlink'])test(`PINNED kernel seam after final stat ${mutation}`,()=>{
 const before=readFileSync(file,'utf8');const bound=openRepairFile(repo,file,true);let error='';const human=before.replace('Keep every byte.','Save human byte.');const other=join(root,'outside.md');writeFileSync(other,'Outside unrelated bytes.');
 try{bound.append(before+'\nRepair suffix.\n',()=>{if(mutation==='in-place'){const fd=openSync(file,'r+');writeSync(fd,Buffer.from(human),0,Buffer.byteLength(human),0);closeSync(fd);}else if(mutation==='symlink'){renameSync(file,file+'.old');symlinkSync(other,file);}else{linkSync(file,join(root,'alias.md'));}});}catch(e){error=String(e);}finally{bound.close();}
 const actual=readFileSync(mutation==='symlink'?file+'.old':file,'utf8');console.log('PINNED_FINAL_STAT',JSON.stringify({mutation,error,actual,outside:readFileSync(other,'utf8'),alias:mutation==='hardlink'?readFileSync(join(root,'alias.md'),'utf8'):null}));
 expect(error.length).toBeGreaterThan(0);expect(readFileSync(other,'utf8')).toBe('Outside unrelated bytes.');if(mutation==='in-place')expect(actual.startsWith(human)).toBe(true);
});

test('TORN append retry retains partial suffix and reports an actionable refusal',async()=>{
 await pair();await seed('Thirdpending');const before=readFileSync(file);let torn!:Buffer;
 const first=await repair({beforeCommit:()=>{const full=readFileSync(file);torn=full.subarray(0,before.length+Math.floor((full.length-before.length)/2));writeFileSync(file,torn);throw Error('simulated process loss after partial append');}});
 const retry=await extract();const again=await extract();console.log('TORN_APPEND',JSON.stringify({first,retry,again,prefixPreserved:readFileSync(file).subarray(0,before.length).equals(before),tornPreserved:readFileSync(file).equals(torn),rows:await rows()}));expect(first.rowsStamped).toBe(0);expect(retry.guardTriggered).toBe(true);expect(Buffer.compare(readFileSync(file), torn)).toBe(0);
});

test('PARSER canonicalization retains intervening prose and rejects duplicate identity; sanitizer covers incomplete tail',()=>{
 const row=(rowNum:number,claim:string,visibility:'world'|'private')=>({rowNum,claim,visibility,kind:'fact' as const,confidence:0.9,notability:'medium' as const,active:true});
 const b='# Fixture\n\n## Facts\n\n'+renderFactsTable([row(4,'Publicfirst','world')])+'\n\nHuman middle paragraph.\n\n## Facts\n\n'+renderFactsTable([row(9,'Privatesecond','private')])+'\nHuman last paragraph.\n';
 const parsed=parseFactsFence(b);const canonical=upsertFactRow(b,row(12,'Publicthird','world')).body;const collision=b+'\n'+renderFactsTable([row(4,'Contradictoryprivate','private')]);
 const malformed=b+'\n<!--- gbrain:facts:begin -->\nSecretmalformedtail';
 console.log('PARSER_SEMANTICS',JSON.stringify({parsed,canonical,collision:parseFactsFence(collision),remote:sanitizeRemoteBody(malformed),strip:stripFactsFence(b)}));
 expect(parsed.facts.map(f=>f.rowNum)).toEqual([4,9]);expect(canonical).toContain('Human middle paragraph.');expect(canonical).toContain('Human last paragraph.');expect(parseFactsFence(canonical).warnings).toEqual([]);expect(parseFactsFence(collision).warnings.some(w=>w.includes('COLLISION'))).toBe(true);expect(sanitizeRemoteBody(malformed)).not.toContain('Privatesecond');expect(sanitizeRemoteBody(malformed)).not.toContain('Secretmalformedtail');expect(stripFactsFence(b)).not.toContain('Privatesecond');
});

test('INVALID UTF8 in committed prefix refuses and preserves all bytes',async()=>{
 await pair();const bytes=Buffer.concat([readFileSync(file),Buffer.from([0xff])]);writeFileSync(file,bytes);git('add','--',SLUG+'.md');git('commit','-qm','invalid fixture');await seed('Thirdpending');const r=await repair();console.log('UTF8_REFUSAL',JSON.stringify({r,bytesEqual:readFileSync(file).equals(bytes)}));expect(r.rowsStamped).toBe(0);expect(readFileSync(file)).toEqual(bytes);
});

test('CONTROL single fence native forget remains effective',async()=>{
 const id=await seed('Onlyone','world');expect((await repair()).rowsStamped).toBe(1);const f=await isolated(()=>forgetFactInFence(engine,Number(id)));await sync();const r=await extract();console.log('FORGET_SINGLE',JSON.stringify({f,r,rows:await rows()}));expect(f).toMatchObject({ok:true,path:'fence'});expect((await rows()).every(x=>x.expired)).toBe(true);
});

for(const remote of [false,true])test(`CLOSURE R7-1 queued actual stale save remote=${remote}`,async()=>{
 const id=await seed('Queuedfact','world');await isolated(async()=>{
 const got=await op('get_page').handler(ctx(remote),{slug:SLUG,include_content:true}) as any;let pending!:Promise<any>;let settled=false;
 const r=await repairLegacyRowsForSource(engine,{sourceId:SOURCE,hooks:{afterRowLock:async()=>{pending=op('put_page').handler(ctx(remote),{slug:SLUG,content:got.content+'\nQueuedhuman.\n'}).catch(e=>({code:e.code,message:e.message})).finally(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,25));expect(settled).toBe(false);}}});const save=await pending;const rec=await extract();console.log('CLOSURE_SAVE',JSON.stringify({remote,id,r,save,rec,rows:await rows()}));expect(save.code).toBe('conflict');expect(rec.factsDeleted).toBe(0);expect((await rows())[0]?.id).toBe(id);
 });
});

test('CLOSURE R7-2 queued native forget follows identity through locked redirect',async()=>{
 const ph='example';writeFileSync(join(repo,ph+'.md'),'# Example\n');await isolated(()=>importFromContent(engine,ph,'# Example\n',{sourceId:SOURCE,noEmbed:true}));git('add','--',ph+'.md');git('commit','-qm','phantom');const id=await seed('Followidentity','world',ph);expect((await repair()).rowsStamped).toBe(1);
 const raw=engine.executeRaw;let pending:Promise<any>|undefined;let reached=false;
 await isolated(async()=>{engine.executeRaw=(async function(this:any,sql:string,args:any[]){const out=await raw.call(this,sql,args);if(!reached&&sql.includes('AND (entity_slug = $2 OR entity_slug = $3)')){reached=true;pending=forgetFactInFence(engine,Number(id));}return out;}) as typeof engine.executeRaw;
 let r;try{r=await runExtractFacts(engine,{sourceId:SOURCE,brainDir:repo,slugs:[ph,SLUG]});}finally{engine.executeRaw=raw;}const f=await pending;await sync();const rec=await extract();const final=await engine.executeRaw('SELECT id::text,entity_slug,expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1',[SOURCE]);console.log('CLOSURE_PHANTOM_FORGET',JSON.stringify({reached,id,r,f,rec,final}));expect(reached).toBe(true);expect(r.phantomsRedirected).toBe(1);expect(final).toEqual([{id,entity_slug:SLUG,expired:true}]);});
});

test('CLOSURE R7-4 real migration refuses provenance and off mode without changing rows or file',async()=>{
 const id=await seed();await engine.executeRaw("UPDATE facts SET source_session='review-session',confidence=0.987 WHERE id=$1",[id]);const before=await engine.executeRaw('SELECT to_jsonb(f)::text AS row FROM facts f WHERE source_id=$1',[SOURCE]);const a=await isolated(()=>migration.phaseBFenceFacts(engine,{sourceId:SOURCE,yes:true,dryRun:false,noAutopilotInstall:true}));await engine.executeRaw('UPDATE facts SET source_session=NULL,confidence=0.9 WHERE id=$1',[id]);const b=await withEnv({GBRAIN_HOME:home,GBRAIN_FACT_REPAIR:'off'},()=>migration.phaseBFenceFacts(engine,{sourceId:SOURCE,yes:true,dryRun:false,noAutopilotInstall:true}));console.log('CLOSURE_MIGRATION',JSON.stringify({a,b,before,after:await rows(),file:readFileSync(file,'utf8')}));expect(a.status).toBe('failed');expect(b.status).toBe('failed');expect(readFileSync(file,'utf8')).toBe(ORIGINAL);expect((await rows())[0]?.row_num).toBeNull();
});

test('PRECISION three SQL time zones preserve created_at microseconds through sibling edit',async()=>{
 for(const zone of ['Europe/Copenhagen','America/Los_Angeles','Pacific/Kiritimati']){
 await engine.executeRaw(`SET TIME ZONE '${zone}'`);const id=await seed('Timestampanchor','world');await seed('Siblingbefore','world');await engine.executeRaw("UPDATE facts SET created_at='2026-01-02T00:00:00.123456Z' WHERE id=$1",[id]);const before=await engine.executeRaw("SELECT created_at::text AS t FROM facts WHERE id=$1",[id]);const stamp=await repair();console.log('PRECISION_STAMP',JSON.stringify({zone,stamp}));expect(stamp.rowsStamped).toBe(2);writeFileSync(file,readFileSync(file,'utf8').replace('Siblingbefore','Siblingafter'));await sync();const rec=await extract();const after=await engine.executeRaw("SELECT created_at::text AS t FROM facts WHERE source_id=$1 AND fact='Timestampanchor'",[SOURCE]);console.log('PRECISION_REAL',JSON.stringify({zone,before,rec,after}));expect(rec.factsInserted).toBe(2);expect(after).toEqual(before);
 await engine.executeRaw('DELETE FROM facts WHERE source_id=$1',[SOURCE]);writeFileSync(file,ORIGINAL);await sync();
 }
});

import { runExport } from '../src/commands/export.ts';
test('PRIVACY private facts in both blocks stay off remote and search; inspect local backup export',async()=>{
 await pair('private','private');await seed('Publicthirdquartz','world');expect((await repair()).rowsStamped).toBe(1);
 const local=(await op('get_page').handler(ctx(false),{slug:SLUG,include_content:true})) as any;
 const remote=(await op('get_page').handler(ctx(true),{slug:SLUG,include_content:true})) as any;
 const chunks1=await chunkHits('Originalfirstquartz');const chunks2=await chunkHits('Originsecondquartz');const world1=await engine.searchKeyword('Originalfirstquartz',{sourceId:SOURCE});const world2=await engine.searchKeyword('Originsecondquartz',{sourceId:SOURCE});
 const exportDir=join(root,'export');await isolated(()=>runExport(engine,['--dir',exportDir,'--slug-prefix','people/']));const exported=readFileSync(join(exportDir,SLUG+'.md'),'utf8');
 console.log('PRIVACY_ALL_BLOCKS',JSON.stringify({localHasFirst:local.content.includes('Originalfirstquartz'),remoteHasFirst:remote.content.includes('Originalfirstquartz'),remoteHasSecond:remote.content.includes('Originsecondquartz'),remoteHasPublic:remote.content.includes('Publicthirdquartz'),chunks1,chunks2,world1,world2,localBackupExportHasFirst:exported.includes('Originalfirstquartz'),localBackupExportHasSecond:exported.includes('Originsecondquartz')}));
 expect(remote.content).not.toContain('Originalfirstquartz');expect(remote.content).not.toContain('Originsecondquartz');expect(remote.content).toContain('Publicthirdquartz');expect(chunks1).toEqual([{n:0}]);expect(chunks2).toEqual([{n:0}]);expect(world1).toEqual([]);expect(world2).toEqual([]);
});

test('REPEATED conflicting row number refuses repair, preserves human content, no shadow reconcile',async()=>{
 await pair();const prior=readFileSync(file,'utf8');const duplicate=renderFactsTable([{rowNum:1,claim:'Humancontradictoryrow',kind:'fact',confidence:0.9,visibility:'world',notability:'medium',active:true}]);const human=prior+'\n\n## Facts\n\n'+duplicate+'\n';writeFileSync(file,human);git('add','--',SLUG+'.md');git('commit','-qm','contradictory fixture');await sync();await seed('Laterpending');const r=await extract();console.log('COLLISION_REFUSAL',JSON.stringify({r,preserved:readFileSync(file,'utf8')===human,rows:await rows()}));expect(r.guardTriggered).toBe(true);expect(r.legacyRowsRepaired).toBe(0);expect(readFileSync(file,'utf8')).toBe(human);
});

test('NATIVE placement helper keeps a newly inserted fence above every timeline sentinel form',()=>{
 const row={claim:'Beforetimeline',kind:'fact' as const,confidence:0.9,visibility:'world' as const,notability:'medium' as const,validFrom:'2026-01-02',source:'api:fixture'};
 for(const tail of ['<!--timeline-->\n\n## Timeline\n- event\n','--- timeline ---\n\n## Timeline\n- event\n','---\n\n## History\n- event\n']){
  const body=ORIGINAL+'\n'+tail;const written=upsertFactRow(body,row).body;const parsed=parseMarkdown(written,'fixture.md');
  expect(parsed.compiled_truth).toContain('Beforetimeline');expect(parsed.timeline).toContain('- event');expect(parseFactsFence(parsed.compiled_truth).warnings).toEqual([]);
 }
});

test('automatic append repair never appends a new fence into the timeline; it refuses the required pre-sentinel rewrite',async()=>{
 const timelineBody=ORIGINAL+'\n<!--timeline-->\n\n## Timeline\n- keep this event\n';
 writeFileSync(file,timelineBody);await isolated(()=>importFromContent(engine,SLUG,timelineBody,{sourceId:SOURCE,noEmbed:true}));
 git('add','--',SLUG+'.md');git('commit','-qm','timeline fixture');await seed('Repairbeforetimeline','world');
 const repaired=await repair();const written=readFileSync(file,'utf8');const parsed=parseMarkdown(written,`${SLUG}.md`);
 expect(repaired.rowsStamped).toBe(0);expect(repaired.skippedByReason.file_rewrite_required).toBe(1);expect(written).toBe(timelineBody);expect(parsed.compiled_truth).not.toContain('Repairbeforetimeline');expect(parsed.timeline).not.toContain('Repairbeforetimeline');expect(parsed.timeline).toContain('keep this event');
});
