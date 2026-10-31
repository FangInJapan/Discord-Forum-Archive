import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveApp} from '../src/app.js';
import {ArchiveStore,makeRecord,identity,cleanPrefs} from '../src/core.js';
const G='111111111111111111',F='222222222222222222',T='333333333333333333';
function app() {
  const data=new Map();const storage={get:async(k,d)=>structuredClone(data.has(k)?data.get(k):d),set:async(k,v)=>data.set(k,structuredClone(v)),list:async()=>[...data.keys()]};
  const a=new ArchiveApp(storage,()=>`https://discord.com/channels/${G}/${T}`);a.profile={id:'profile-school',name:'School'};a.store=new ArchiveStore(storage,a.profile.id);
  const messages=[];a.toast=(...args)=>messages.push(args);a.renderList=()=>{};a.updateContext=()=>{};
  a.adapter={inspect:()=>({type:'thread',guildId:G,threadId:T,forumId:null,originalTitle:'完整标题'}),title:()=>'',main:()=>null};
  return {a,data,messages};
}
test('manual page save succeeds and repeated save is idempotent',async()=>{
  const {a,messages}=app();await a.saveCurrent();assert.equal(a.store.records.size,1);assert.equal(messages.length,1);
  await a.saveCurrent();assert.equal(a.store.records.size,1);assert.equal(messages.length,2);
});
test('application does not issue success toast when storage write fails',async()=>{
  const {a,messages}=app();a.storage.set=async()=>{throw new Error('quota');};
  await assert.rejects(a.saveCurrent(),/quota/);assert.equal(messages.length,0);assert.equal(a.store.records.size,0);
});
test('unrecognized direct post URL saves with unknown parent after one click',async()=>{
  const {a}=app();a.adapter.inspect=()=>({type:'unknown',guildId:G,channelId:T});
  await a.saveCurrent();assert.equal(a.store.records.size,1);assert.equal([...a.store.records.values()][0].forumId,null);
});
test('follow capture is opt-in and never overwrites a custom name',async()=>{
  const {a}=app(),c=a.adapter.inspect();a.prefs.autoFollow=false;await a.capture(c);assert.equal(a.store.records.size,0);
  a.prefs.autoFollow=true;await a.store.add(makeRecord(c));await a.store.patch(identity(c),{customTitle:'My name'});
  await a.capture({...c,originalTitle:'Remote changed'});assert.equal(a.store.records.get(identity(c)).customTitle,'My name');assert.equal(a.store.records.get(identity(c)).originalTitle,'Remote changed');
});
test('preference queue merges same-tab writes and preserves per-server filters',async()=>{
  const {a}=app();await Promise.all([a.savePrefs({titleSize:18}),a.savePrefs({width:600}),a.savePrefs({filters:{[G]:{scope:'server',sort:'starred'}}})]);
  assert.equal(a.prefs.titleSize,18);assert.equal(a.prefs.width,600);assert.equal(a.currentFilter().scope,'forum');
  a.context={guildId:G};assert.equal(a.currentFilter().scope,'server');a.context={guildId:G,forumId:F};assert.equal(a.currentFilter().scope,'server');
});
test('layout modes, DM hiding and explicit recovery retain original dimensions',()=>{
  const {a}=app();const previous=[globalThis.innerWidth,globalThis.innerHeight];globalThis.innerWidth=1000;globalThis.innerHeight=800;
  a.panel={style:{}},a.tab={style:{}},a.quick={};a.host={style:{setProperty:()=>{}}};a.prefs=cleanPrefs({width:620,height:500,mode:'expanded'});
  try {
    a.context={type:'forum',guildId:G};a.layout();assert.equal(a.panel.hidden,false);assert.equal(a.tab.hidden,true);
    a.prefs.mode='collapsed';a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,false);
    a.prefs.mode='expanded';a.context={type:'dm'};a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,true);
    a.force=true;a.layout();assert.equal(a.panel.hidden,false);assert.equal(a.prefs.width,620);assert.equal(a.prefs.height,500);
    a.prefs.mode='hidden';a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,true);
  }finally{[globalThis.innerWidth,globalThis.innerHeight]=previous;}
});
