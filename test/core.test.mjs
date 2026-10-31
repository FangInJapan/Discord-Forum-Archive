import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore,canonical,cleanPrefs,exportData,geometry,identity,makeRecord,mergeImport,parseImport,parseLink,reduceOperations,selectRecords,validateRecord} from '../src/core.js';
const G='111111111111111111',F='222222222222222222',T='333333333333333333',U='444444444444444444',OTHER='555555555555555555';
const record=(id=T,extra={})=>makeRecord({guildId:G,threadId:id,forumId:F,forumName:'電気交流',originalTitle:'教程2 '+ '日本語中文 English 🧪'.repeat(12),...extra},'manual-page',1000);
class Memory {
  constructor(){this.data=new Map();this.fail=false;this.ignore=false;}
  async list(){return [...this.data.keys()];}
  async get(k,d){return structuredClone(this.data.has(k)?this.data.get(k):d);}
  async set(k,v){if(this.fail)throw new Error('quota');if(!this.ignore)this.data.set(k,structuredClone(v));}
}
test('links: exact official host, preserve string IDs, message ID is not thread ID',()=>{
  assert.equal(parseLink(`https://discord.com/channels/${G}/${T}/${U}`).threadId,T);
  assert.equal(parseLink(`https://ptb.discord.com/channels/${G}/${T}?x=1`).url,canonical(G,T));
  for(const link of [`http://discord.com/channels/${G}/${T}`,`https://discord.com.evil/channels/${G}/${T}`,`https://evil@discord.com/channels/${G}/${T}`,`https://discord.com/channels/@me/${T}`,`https://discord.com/channels/${G}/abc`,`https://discord.com/channels/${G}/${T}/123`,`https://discord.com/channels/${G}`])assert.throws(()=>parseLink(link));
});
test('refresh, independent native state, duplicates and complete long titles',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');await a.add(record());await a.add(record());
  const b=new ArchiveStore(mem,'profile-school');await b.refresh();
  assert.equal(b.records.size,1);assert.equal(b.records.get(`${G}:${T}`).originalTitle,record().originalTitle);
  await b.observe({guildId:G,threadId:T,originalTitle:'远端新标题'},true);
  await a.refresh();assert.equal(a.records.get(`${G}:${T}`).nativeFollowState,'following');
  await a.refresh();assert.equal(a.records.size,1);
});
test('simultaneous different posts survive, field-level edits merge deterministically',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school'),b=new ArchiveStore(mem,'profile-school');
  await Promise.all([a.add(record()),b.add(record(U))]);await Promise.all([a.refresh(),b.refresh()]);
  assert.equal(a.records.size,2);assert.equal(b.records.size,2);
  await Promise.all([a.patch(`${G}:${T}`,{customTitle:'自定义'}),b.patch(`${G}:${T}`,{starred:true})]);
  await Promise.all([a.refresh(),b.refresh()]);
  assert.deepEqual([...a.records],[...b.records]);assert.equal(a.records.get(`${G}:${T}`).customTitle,'自定义');assert.equal(a.records.get(`${G}:${T}`).starred,true);
  await Promise.all([a.patch(`${G}:${T}`,{customTitle:'甲'}),b.patch(`${G}:${T}`,{customTitle:'乙'})]);await a.refresh();await b.refresh();
  assert.deepEqual([...a.records],[...b.records]);assert.ok(['甲','乙'].includes(a.records.get(`${G}:${T}`).customTitle));
});
test('delete propagates; late observations and edits never resurrect; explicit re-add works',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school'),b=new ArchiveStore(mem,'profile-school');
  await a.add(record());await b.refresh();await a.remove(`${G}:${T}`);
  await b.patch(`${G}:${T}`,{starred:true});await a.refresh();assert.equal(a.records.size,0);
  await b.observe({guildId:G,threadId:T,originalTitle:'changed'},true);await a.refresh();assert.equal(a.records.size,0);
  await b.add(record());await a.refresh();assert.equal(a.records.size,1);
});
test('rename keeps original; observation fills only known empty parent',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');await a.add(record(T,{forumId:null,forumName:''}));
  await a.patch(`${G}:${T}`,{customTitle:'My title'});await a.observe({guildId:G,threadId:T,originalTitle:'Remote title',forumId:F,forumName:'Parent'});
  const r=a.records.get(`${G}:${T}`);assert.equal(r.customTitle,'My title');assert.equal(r.originalTitle,'Remote title');assert.equal(r.forumId,F);
  await a.observe({guildId:G,threadId:T,forumId:OTHER});assert.equal(a.records.get(`${G}:${T}`).forumId,F);
});
test('automatic native capture cannot resurrect an explicitly deleted bookmark',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school'),b=new ArchiveStore(mem,'profile-school');
  await a.add(record(),{automatic:true});await b.refresh();await a.remove(`${G}:${T}`);
  assert.equal(await b.add(record(),{automatic:true}),undefined);await a.refresh();assert.equal(a.records.size,0);
  await a.add(record());await b.refresh();assert.equal(b.records.size,1);
});
test('storage exceptions and silently rejected writes do not enter successful local state',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');mem.fail=true;
  await assert.rejects(a.add(record()),/quota/);assert.equal(a.records.size,0);mem.fail=false;mem.ignore=true;
  await assert.rejects(a.add(record()),/校验失败/);assert.equal(a.records.size,0);
});
test('corrupt operations are reported and preserved; incompatible schema cannot wipe data',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');await a.add(record());
  mem.data.set(a.prefix+'brokenkey',{schemaVersion:99});await a.refresh();assert.equal(a.invalidCount,1);assert.equal(a.records.size,1);assert.ok(mem.data.has(a.prefix+'brokenkey'));
});
test('explicit profiles isolate all data',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school'),b=new ArchiveStore(mem,'profile-private');await a.add(record());await b.refresh();assert.equal(b.records.size,0);
});
test('server/forum isolation, pending parent, NFKC search and natural sorting',()=>{
  const r1=record(T,{originalTitle:'教程10'}),r2=record(U,{originalTitle:'教程2'}),r3=record(OTHER,{forumId:null,forumName:'',originalTitle:'待归属'}),r4=record(T,{guildId:OTHER});
  const list=[r1,r2,r3,r4];assert.equal(selectRecords(list,{guildId:G,forumId:F}).length,2);
  assert.deepEqual(selectRecords(list,{guildId:G,forumId:F,sort:'title-asc'}).map(r=>r.threadId),[U,T]);
  assert.equal(selectRecords(list,{guildId:G,scope:'server'}).length,3);
  assert.equal(selectRecords(list,{guildId:G,scope:'server',query:'電気'}).length,2);
  assert.equal(selectRecords(list,{guildId:G,forumId:null})[0].threadId,OTHER);
});
test('all sort modes work with deterministic ties',()=>{
  const a=record(T,{originalTitle:'A'}),b={...record(U,{originalTitle:'B'}),savedAt:2000,modifiedAt:3000,starred:true};
  for(const [sort,first] of [['saved-asc',T],['saved-desc',U],['modified-asc',T],['modified-desc',U],['title-asc',T],['title-desc',U],['starred',U]])assert.equal(selectRecords([a,b],{guildId:G,scope:'server',sort})[0].threadId,first);
});
test('JSON round trip preserves records, identity, sources, classification and times',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');await a.add({...record(),customTitle:'<img src=x onerror=alert(1)>',starred:true});
  const data=exportData(a.records.values(),{id:'profile-school',name:'学校'}),parsed=parseImport(JSON.stringify(data));
  const b=new ArchiveStore(mem,'profile-restored');await mergeImport(b,parsed.records);
  assert.deepEqual([...b.records],[...a.records]);assert.equal(data.forums[0].forumId,F);assert.equal(data.servers[0].guildId,G);
});
test('import preview deduplicates and default merge preserves custom title and star',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school'),original={...record(),customTitle:'Local',starred:true};await a.add(original);
  const incoming={...record(),customTitle:'Incoming',starred:false};
  const data=exportData([incoming,incoming],{id:'profile-school',name:'学校'}),parsed=parseImport(JSON.stringify(data));assert.equal(parsed.duplicates,1);
  await mergeImport(a,parsed.records);assert.equal(a.records.get(identity(original)).customTitle,'Local');assert.equal(a.records.get(identity(original)).starred,true);
  await mergeImport(a,parsed.records,'incoming');assert.equal(a.records.get(identity(original)).customTitle,'Incoming');assert.equal(a.records.get(identity(original)).starred,false);
});
test('reject invalid import entirely before writes, large payloads and future schema',async()=>{
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');
  for(const raw of ['{',JSON.stringify({format:'discord-forum-archive',schemaVersion:99,records:[]}),JSON.stringify(exportData([record()],{id:'profile-school',name:'学校'})).replace(`"threadId":"${T}"`,`"threadId":${T}`),'x'.repeat(10*1024*1024+1)])assert.throws(()=>parseImport(raw));
  await assert.rejects(mergeImport(a,[record(),{guildId:123}]));assert.equal(mem.data.size,0);
  assert.throws(()=>validateRecord({...record(),forumId:T}));assert.throws(()=>validateRecord({...record(),originalTitle:'a'.repeat(20001)}));
});
test('geometry stays reachable in small/large viewports with every dock and both modes',()=>{
  for(const width of [250,375,800,1920])for(const height of [180,667,1080])for(const dock of ['left','right','top','bottom','none'])for(const collapsed of [true,false]){
    const r=geometry({...cleanPrefs(),dock,x:1,y:1},{width,height},collapsed);
    assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=width+.001&&r.y+r.height<=height+.001,JSON.stringify(r));
  }
  const p=cleanPrefs({titleSize:99,lines:6,theme:'garbage',x:-3,width:NaN,filters:{'__proto__':{},[G]:{scope:'server',sort:'starred'}}});
  assert.equal(p.titleSize,22);assert.equal(p.lines,4);assert.equal(p.theme,'discord');assert.equal(p.x,0);assert.equal(p.filters[G].scope,'server');
});
test('500-post search/sort and out-of-order operation reconstruction',async()=>{
  const records=Array.from({length:500},(_,i)=>record(String(BigInt(T)+BigInt(i)),{originalTitle:`教程${i} ${'长标题'.repeat(50)}`}));
  const start=performance.now();const result=selectRecords(records,{guildId:G,scope:'server',query:'长标题',sort:'title-asc'});
  assert.equal(result.length,500);assert.equal(result[2].originalTitle,records[2].originalTitle);assert.ok(performance.now()-start<1000);
  const mem=new Memory(),a=new ArchiveStore(mem,'profile-school');await a.add(record());await a.patch(`${G}:${T}`,{starred:true});await a.remove(`${G}:${T}`);
  assert.equal(reduceOperations([...a.ops.values()].reverse()).size,0);
});

test('legacy bookmarks enter default folder; folder aliases and backup survive round trip',()=>{
  const legacy=record();
  delete legacy.collectionId;delete legacy.titleUpdatedAt;
  const migrated=validateRecord(legacy);
  assert.equal(migrated.collectionId,'default');
  assert.equal(migrated.titleUpdatedAt,null);
  const prefs=cleanPrefs({folders:[{id:'default',name:'默认资料'},{id:'my-folder-001',name:'教程'}],
    folderSelections:{[G]:'my-folder-001'},guildAliases:{[G]:'自定义服务器'},
    forumAliases:{[G+':'+F]:'自定义论坛'}});
  assert.equal(prefs.folders[0].name,'默认资料');
  assert.equal(prefs.folderSelections[G],'my-folder-001');
  const second=record(U,{collectionId:'my-folder-001'});
  assert.deepEqual(selectRecords([migrated,second],{guildId:G,scope:'server',collectionId:'my-folder-001'}).map(r=>r.threadId),[U]);
  const copy=parseImport(JSON.stringify(exportData([migrated,second],{id:'test',name:'测试'},prefs)));
  assert.equal(copy.folders[1].name,'教程');
  assert.equal(copy.records[1].collectionId,'my-folder-001');
  assert.equal(copy.guildAliases[G],'自定义服务器');
  assert.equal(copy.forumAliases[G+':'+F],'自定义论坛');
  assert.throws(()=>validateRecord({...migrated,collectionId:'invalid folder id'}));
});
