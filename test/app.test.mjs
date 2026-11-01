import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveApp,isolatePanelEvents} from '../src/app.js';
import {ArchiveStore,makeRecord,identity,cleanPrefs,PREFIX} from '../src/core.js';
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
  assert.equal(a.prefs.titleSize,18);assert.equal(a.prefs.width,600);assert.equal(a.currentFilter().scope,'server');
  a.context={guildId:G};assert.equal(a.currentFilter().scope,'server');a.context={guildId:G,forumId:F};assert.equal(a.currentFilter().scope,'server');
});
test('layout modes, DM hiding and explicit recovery retain original dimensions',()=>{
  const {a}=app();const previous=[globalThis.innerWidth,globalThis.innerHeight];globalThis.innerWidth=1000;globalThis.innerHeight=800;
  a.panel={style:{}},a.tab={style:{}},a.quick={};a.host={style:{setProperty:()=>{}},dataset:{}};a.prefs=cleanPrefs({width:620,height:500,mode:'expanded'});
  try {
    a.context={type:'forum',guildId:G};a.layout();assert.equal(a.panel.hidden,false);assert.equal(a.tab.hidden,true);
    a.prefs.mode='collapsed';a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,false);
    a.prefs.mode='collapsed';a.context={type:'unknown',guildId:G};a.layout();
    assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,false,'temporary unknown route must preserve collapsed mode');
    a.prefs.mode='expanded';a.context={type:'unknown',guildId:G};a.layout();
    assert.equal(a.panel.hidden,false,'temporary unknown route must preserve expanded mode');
    a.context={type:'thread',guildId:G,threadId:T};a.layout();
    assert.equal(a.panel.hidden,false,'opening a thread must preserve expanded mode');
    a.prefs.mode='expanded';a.context={type:'dm'};a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,true);
    a.force=true;a.layout();assert.equal(a.panel.hidden,false);assert.equal(a.prefs.width,620);assert.equal(a.prefs.height,500);
    a.prefs.mode='hidden';a.layout();assert.equal(a.panel.hidden,true);assert.equal(a.tab.hidden,true);
  }finally{[globalThis.innerWidth,globalThis.innerHeight]=previous;}
});

test('Shadow DOM isolation keeps native input defaults and local handlers intact',()=>{
  const root=new EventTarget();
  const clear=isolatePanelEvents(root);
  let localHandlers=0;
  root.addEventListener('keydown',()=>localHandlers++);
  for(const type of ['keydown','keypress','keyup','beforeinput','input','compositionstart','compositionend','paste','focusin','click']) {
    const event=new Event(type,{bubbles:true,cancelable:true,composed:true});
    root.dispatchEvent(event);
    assert.equal(event.cancelBubble,true,type+' must be isolated');
    assert.equal(event.defaultPrevented,false,type+' must retain native input behavior');
  }
  assert.equal(localHandlers,1,'stopPropagation must not cancel same-root handlers');
  clear();
  const later=new Event('keydown',{bubbles:true});
  root.dispatchEvent(later);
  assert.equal(later.cancelBubble,false,'listener cleanup must restore propagation');
});

test('focus inside a Shadow DOM input marks host editable for document-capture shortcuts',async()=>{
  const attrs=new Map();
  const host={
    getAttribute:key=>attrs.has(key)?attrs.get(key):null,
    setAttribute:(key,value)=>attrs.set(key,String(value)),
    removeAttribute:key=>attrs.delete(key)
  };
  const listeners=new Map();
  const root={host,activeElement:null,
    addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn)
  };
  const fire=(type,target)=>{
    const event={type,target,stopPropagation:()=>{}};
    for(const listener of listeners.get(type)||[])listener(event);
  };
  const clear=isolatePanelEvents(root);
  const textbox={matches:selector=>selector.includes('input:not')};
  root.activeElement=textbox;fire('focusin',textbox);
  assert.equal(host.getAttribute('contenteditable'),'true');
  assert.equal(host.getAttribute('tabindex'),'-1');
  root.activeElement=null;fire('focusout',textbox);
  await Promise.resolve();
  assert.equal(host.getAttribute('contenteditable'),null);
  root.activeElement=textbox;fire('focusin',textbox);
  clear();
  assert.equal(host.getAttribute('contenteditable'),null);
});

test('three-way filter persists server-wide and no longer depends on a broken forum/server switch',async()=>{
  const {a}=app();a.context={type:'forum',guildId:G,forumId:F};
  a.sort={value:'saved-desc'};a.viewMode='missing';
  await a.filterChange();
  assert.deepEqual(a.currentFilter(),{scope:'server',sort:'saved-desc',updates:'missing'});
  assert.equal(a.prefs.filters[G].updates,'missing');
  a.viewMode='changed';await a.filterChange();
  assert.equal(a.currentFilter().updates,'changed');
  assert.equal(a.currentFilter().scope,'server');
});

test('manual scan records only verified forum; no posts means no missing-state update',async()=>{
  const {a}=app();a.context={type:'forum',guildId:G,forumId:F};
  a.adapter={inspect:()=>({type:'forum',guildId:G,forumId:F}),collectVisiblePosts:()=>[]};
  await a.store.add(makeRecord({guildId:G,threadId:T,forumId:F,originalTitle:'旧标题'}));
  await a.refreshVisibleTitles();
  assert.deepEqual(a.prefs.scanResults,{});
  const U='444444444444444444';
  await a.store.add(makeRecord({guildId:G,threadId:U,forumId:F,originalTitle:'另一个帖子'}));
  a.adapter.collectVisiblePosts=()=>[{guildId:G,forumId:F,threadId:T,originalTitle:'新标题'}];
  await a.refreshVisibleTitles();
  assert.equal(a.prefs.scanResults[G+':'+F].visibleCount,1);
  assert.deepEqual(a.prefs.scanResults[G+':'+F].missing,[U]);
  assert.equal(a.store.records.get(G+':'+T).changeUnread,true);
  assert.equal(a.store.records.get(G+':'+U).changeUnread,false);
});

test('bookmarked post navigation preserves scroll, search, and pagination within one server',async()=>{
  const {a}=app();a.context={type:'forum',guildId:G,forumId:F};
  a.list={scrollTop:456};a.search={value:'实验'};a.query='实验';a.limit=160;a.layout=()=>{};
  await a.navigate({type:'thread',guildId:G,threadId:T,forumId:F,originalTitle:'帖子'});
  assert.equal(a.list.scrollTop,456);
  assert.equal(a.scroll.get(G),456);
  assert.equal(a.query,'实验');assert.equal(a.search.value,'实验');assert.equal(a.limit,160);
  a.list.scrollTop=710;
  await a.navigate({type:'forum',guildId:G,forumId:'444444444444444444'});
  assert.equal(a.list.scrollTop,710,'other channel in same server retains current scroll');
  await a.navigate({type:'forum',guildId:'555555555555555555',forumId:'666666666666666666'});
  assert.equal(a.list.scrollTop,0,'a different server starts at top');
  assert.equal(a.query,'');assert.equal(a.limit,80);
  a.list.scrollTop=100;
  await a.navigate({type:'forum',guildId:G,forumId:F});
  assert.equal(a.list.scrollTop,710,'returning to prior server restores previous position');
});
test('bookmark click checkpoint can be consumed after full reload without cross-tab storage',()=>{
  const original=globalThis.sessionStorage,entries=new Map();
  globalThis.sessionStorage={
    setItem:(key,value)=>entries.set(key,value),
    getItem:key=>entries.get(key)||null,
    removeItem:key=>entries.delete(key)
  };
  try{
    const {a}=app();a.context={type:'thread',guildId:G,threadId:T};
    a.list={scrollTop:840};a.query='查看';a.limit=240;
    a.captureBookmarkScroll();
    const key=PREFIX+'scroll:'+a.profile.id;
    assert.ok(entries.has(key));
    const restored=app().a.takeBookmarkScroll(a.profile.id);
    assert.deepEqual(restored,{guildId:G,top:840,query:'查看',limit:240});
    assert.equal(entries.has(key),false,'checkpoint is one-shot');
  }finally{globalThis.sessionStorage=original;}
});

test('current bookmark highlighting switches with the active thread and clears on forum',async()=>{
  const {a}=app();
  const U='444444444444444444';
  await a.store.add(makeRecord({guildId:G,threadId:T,forumId:F,originalTitle:'当前帖子'}));
  await a.store.add(makeRecord({guildId:G,threadId:U,forumId:F,originalTitle:'另一帖子'}));
  const fakeCard=key=>{
    const attrs=new Map(),classes=new Set();
    const link={
      setAttribute:(k,v)=>attrs.set(k,v),
      removeAttribute:k=>attrs.delete(k)
    };
    return {key,classes,attrs,link,
      classList:{toggle:(k,yes)=>yes?classes.add(k):classes.delete(k)},
      getAttribute:keyName=>keyName==='data-post-key'?key:null,
      querySelector:()=>link
    };
  };
  const first=fakeCard(G+':'+T),second=fakeCard(G+':'+U);
  a.list={querySelectorAll:()=>[first,second]};
  a.context={type:'thread',guildId:G,threadId:T};
  a.highlightCurrentPost();
  assert.equal(first.classes.has('is-current-post'),true);
  assert.equal(first.attrs.get('aria-current'),'page');
  assert.equal(second.attrs.has('aria-current'),false);
  assert.equal(second.classes.has('is-current-post'),false);
  a.context={type:'thread',guildId:G,threadId:U};
  a.highlightCurrentPost();
  assert.equal(first.classes.has('is-current-post'),false);
  assert.equal(second.classes.has('is-current-post'),true);
  assert.equal(second.attrs.get('aria-current'),'page');
  assert.equal(first.attrs.has('aria-current'),false);
  a.context={type:'forum',guildId:G,forumId:F};
  a.highlightCurrentPost();
  assert.equal(first.classes.has('is-current-post'),false);
  assert.equal(second.classes.has('is-current-post'),false);
  assert.equal(second.attrs.has('aria-current'),false);
  a.context={type:'unknown',guildId:G,channelId:T};
  assert.equal(a.currentPostIdentity(),G+':'+T,'unclassified direct saved-thread link should still highlight');
  a.context={type:'unknown',guildId:G,channelId:F};
  assert.equal(a.currentPostIdentity(),null,'a forum channel must not appear as a saved post');
});

test('focusing the selected bookmark respects filters and scrolls only when outside the viewport',async()=>{
  const {a}=app();const U='444444444444444444';
  await a.store.add(makeRecord({guildId:G,threadId:T,forumId:F,originalTitle:'A'}));
  await a.store.add(makeRecord({guildId:G,threadId:U,forumId:F,originalTitle:'B'}));
  a.context={type:'thread',guildId:G,threadId:T};
  a.panel={hidden:false};
  let position=25,renderCalls=0;
  const card={
    getAttribute:key=>key==='data-post-key'?G+':'+T:null,
    getBoundingClientRect:()=>({top:300,bottom:360,height:60})
  };
  a.list={scrollTop:25,clientHeight:180,scrollHeight:800,
    getBoundingClientRect:()=>({top:100,bottom:280,height:180}),
    querySelectorAll:()=>[card],
    scrollTo:({top,behavior})=>{position=top;a.list.scrollTop=top;a.list.lastBehavior=behavior;}
  };
  a.prefs.motion=false;
  a.focusCurrentPost();
  assert.equal(position,25+300-100-(180-60)/2);
  assert.equal(a.list.lastBehavior,'auto');
  assert.equal(renderCalls,0);
  card.getBoundingClientRect=()=>({top:130,bottom:190,height:60});
  a.focusCurrentPost();
  assert.equal(position,165,'an already visible card should not be scrolled again');
  a.query='does not match';
  a.focusCurrentPost();assert.equal(position,165,'filtered-out bookmarks must not force a scroll');
  a.query='';
  a.panel.hidden=true;
  a.focusCurrentPost();assert.equal(position,165,'collapsed panels should not scroll');
});
test('opening bookmark prioritizes visible Discord-native anchor while retaining fallback and modified click',()=>{
  const {a}=app();a.profile={id:'profile-school',name:'School'};
  a.context={type:'forum',guildId:G,forumId:F};
  a.list={scrollTop:100};let captures=0,clicks=0;
  a.captureBookmarkScroll=()=>captures++;
  a.findNativePostLink=()=>({click:()=>clicks++});
  const r=makeRecord({guildId:G,threadId:T,forumId:F,originalTitle:'A'});
  const event=()=>({button:0,defaultPrevented:false,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,preventDefault(){this.prevented=true;}});
  const e=event();a.openBookmarkedPost(e,r);
  assert.equal(e.prevented,true);assert.equal(clicks,1);assert.equal(captures,1);
  a.findNativePostLink=()=>null;
  const fallback=event();a.openBookmarkedPost(fallback,r);
  assert.equal(fallback.prevented,undefined);assert.equal(captures,2);
  const modified={...event(),ctrlKey:true};
  a.openBookmarkedPost(modified,r);
  assert.equal(captures,2,'modifier clicks must remain untouched');
});
