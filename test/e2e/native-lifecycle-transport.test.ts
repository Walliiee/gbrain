/** Real CLI + stdio MCP regression over an isolated keyless PGLite brain.
 * Transport is lexical; real vector behavior is covered by the shared engine contract.
 * Never inherits operator database URLs or provider credentials. */
import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {keylessBrainEnv} from '../helpers/provider-env.ts';

const cwd=process.cwd();
const marker='nativecoslifecyclequokka';
const OLD='lifecycle-old-fixture';
const ACTIVE='lifecycle-active-fixture';
const PRIVATE='lifecycle-private-fixture';
const FOREIGN='lifecycle-foreign-fixture';
const receipt:any={synthetic:true,production_touched:false,checks:[]};

function cli(env:Record<string,string>,args:string[],allowError=false){
 const r=spawnSync('bun',['--no-env-file','run','src/cli.ts',...args],{cwd,env,encoding:'utf8',timeout:60000});
 if(!allowError&&r.status!==0)throw new Error(`Fixture CLI failed: ${args.slice(0,2).join(' ')}: ${r.status}\n${r.stderr}`);
 return r;
}
function textOf(r:any){return (r.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');}
async function session(env:Record<string,string>,check:(c:Client)=>Promise<void>){
 const transport=new StdioClientTransport({command:'bun',args:['--no-env-file','run','src/cli.ts','serve'],cwd,env,stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'parent-lifecycle-acceptance',version:'1.0.0'},{capabilities:{}});
 try{await client.connect(transport);await check(client);}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
}
async function search(client:Client,extra:Record<string,unknown>={}){
 const r=await client.callTool({name:'search',arguments:{query:marker,source_id:'default',limit:2,...extra}});
 expect(r.isError).not.toBe(true);
 const rows=JSON.parse(textOf(r));expect(Array.isArray(rows)).toBe(true);return rows;
}
function slugs(rows:any[]){return rows.map(r=>r.slug);}

test('actual CLI and stdio MCP respect lifecycle and DB-effective config',async()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'cos-native-transport-')));
 const env=keylessBrainEnv({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',TERM:'dumb'},home,{DATABASE_URL:undefined,GBRAIN_DATABASE_URL:undefined,GBRAIN_SOURCE:undefined,NO_COLOR:'1'});
 receipt.started_at=new Date().toISOString();
 try{
  cli(env,['init','--pglite','--no-embedding','--non-interactive']);
  const notes=join(home,'notes');mkdirSync(notes);
  const page=(slug:string,status:string,old=false,privatePage=false)=>`---\ntitle: "${old?marker:'Current synthetic instruction'}"\nstatus: ${status}\n${privatePage?'visibility: private\n':''}---\n\n${Array(old?24:1).fill(marker).join(' ')}\n${old?'':Array(80).fill('fixture background context').join(' ')}\n${slug}\n`;
  writeFileSync(join(notes,OLD+'.md'),page(OLD,'superseded',true));
  writeFileSync(join(notes,ACTIVE+'.md'),page(ACTIVE,'active'));
  writeFileSync(join(notes,PRIVATE+'.md'),page(PRIVATE,'active',false,true));
  cli(env,['import',notes,'--no-embed']);
  const other=join(home,'other');mkdirSync(other);
  writeFileSync(join(other,FOREIGN+'.md'),page(FOREIGN,'active'));
  cli(env,['sources','add','fixture-other','--path',other,'--federated','--force']);
  cli(env,['import',other,'--no-embed','--source-id','fixture-other']);
  cli(env,['config','set','search.mode','conservative']);
  const before=cli(env,['search',marker,'--source-id','default','--limit','1']);
  expect(before.stdout).toContain(OLD);receipt.checks.push('CLI unconfigured control returns history');
  await session(env,async c=>{
   const rows=await search(c,{limit:1});expect(slugs(rows)).toContain(OLD);
   receipt.checks.push('real MCP unconfigured control returns history');
  });
  const policy='["archived","superseded","retired"]';
  cli(env,['config','set','search.exclude_statuses',policy]);
  const configPath=join(home,'.gbrain','config.json');const config=JSON.parse(readFileSync(configPath,'utf8'));
  config.search={...(config.search??{}),exclude_statuses:['archived']};
  writeFileSync(configPath,JSON.stringify(config));
  const readback=cli(env,['config','get','search.exclude_statuses']);
  receipt.config_get=readback.stdout;
  expect(readback.stdout.split('\n')[0]).toContain('superseded');
  receipt.checks.push('actual CLI readback reports DB policy, not conflicting file value');
  const after=cli(env,['search',marker,'--source-id','default','--limit','2']);
  expect(after.stdout).toContain(ACTIVE);expect(after.stdout).not.toContain(OLD);expect(after.stdout).not.toContain(FOREIGN);
  receipt.checks.push('configured CLI filters history before output and retains source scope');
  await session(env,async c=>{
   const rows=await search(c);expect(slugs(rows)).toContain(ACTIVE);
   expect(slugs(rows)).not.toContain(OLD);expect(slugs(rows)).not.toContain(PRIVATE);expect(slugs(rows)).not.toContain(FOREIGN);
   receipt.checks.push('actual MCP filters history/private/foreign and fills eligible result');
   const bypass=await c.callTool({name:'search',arguments:{query:marker,source_id:'default',limit:2,exclude_statuses:[],include_inactive:true}});
   receipt.bypass_reply=bypass;
   if(!bypass.isError)expect(slugs(JSON.parse((bypass as any).content[0].text))).not.toContain(OLD);
   receipt.checks.push('remote unknown parameters cannot bypass operator policy');
   const historical=await c.callTool({name:'get_page',arguments:{slug:OLD,source_id:'default'}});
   expect(historical.isError).not.toBe(true);expect(textOf(historical)).toContain(marker);
   receipt.checks.push('explicit historical MCP get remains available');
  });
  const invalid=cli(env,['config','set','search.exclude_statuses','null'],true);
  expect(invalid.status).toBe(1);expect(invalid.stdout+invalid.stderr).toContain('JSON array');
  expect(cli(env,['config','get','search.exclude_statuses']).stdout.split('\n')[0]).toContain('superseded');
  receipt.checks.push('invalid CLI policy rejected without losing valid DB policy');
  cli(env,['config','unset','search.exclude_statuses']);
  const absent=cli(env,['config','get','search.exclude_statuses'],true);receipt.absent_config_get=absent.stdout;
  expect(JSON.parse(absent.stdout.trim())).toEqual([]);
  expect(cli(env,['search',marker,'--source-id','default','--limit','1']).stdout).toContain(OLD);
  receipt.checks.push('unset restores history and file-only policy is not misreported as effective');
  receipt.status='passed';
 }catch(e){receipt.status='failed';receipt.error=e instanceof Error?e.message:String(e);throw e;}
 finally{
  rmSync(home,{recursive:true,force:true});receipt.finished_at=new Date().toISOString();receipt.temp_home_removed=true;
  const receiptPath=process.env.GBRAIN_LIFECYCLE_RECEIPT_PATH;
  if(receiptPath)writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
 }
},240000);
