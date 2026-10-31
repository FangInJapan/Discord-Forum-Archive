// DOM boundary tests use explicit small stubs, not a real browser or Discord account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscordAdapter,FOLLOW,UNFOLLOW,routeOf} from '../src/discord.js';
const G='111111111111111111',F='222222222222222222',T='333333333333333333';
function fake({forum=false,following=false,known=false,query='',sidebar=false}={}) {
  const heading={textContent:'完整标题 '+ '日本語 中文 English 🧪'.repeat(10),closest:()=>null,getClientRects:()=>[{}]};
  const button={textContent:following?'Unfollow':'Follow',getAttribute:()=>null,closest:()=>null,getClientRects:()=>[{}],isConnected:true,disabled:false};
  const header={querySelectorAll:()=>[button]};
  const forumList={contains:()=>true};
  const main={querySelector:()=>forum?forumList:null,querySelectorAll:s=>s.includes('button')?[]:[heading]};
  const doc={querySelector:()=>main,querySelectorAll:s=>s.includes('main header')?[header]:s.includes('threadSidebar')?(sidebar?[{getAttribute:()=>T,closest:()=>null,getClientRects:()=>[{}],querySelectorAll:()=>[heading]}]:[]):[]};
  let url=`https://discord.com/channels/${G}/${forum?F:T}${query}`;
  const adapter=new DiscordAdapter(doc,()=>{},()=>{},()=>false,()=>{},()=>url);
  if(known)adapter.knownThreads.set(`${G}:${T}`,{guildId:G,threadId:T,forumId:F,forumName:'Parent'});
  return {adapter,button,heading,setHref:v=>url=v};
}
test('route parsing handles server, DM, invalid routes; never uses message as thread ID',()=>{
  assert.equal(routeOf(`https://discord.com/channels/${G}/${T}/999999999999999999`).channelId,T);
  assert.equal(routeOf('https://discord.com/channels/@me').type,'dm');
  assert.equal(routeOf('https://discord.com/login').guildId,null);
});
test('language patterns are exact; destructive inverse labels are not affirmative actions',()=>{
  for(const v of ['Follow','Follow Post','Join Thread','关注帖子','加入帖子','フォローする','参加する'])assert.ok(FOLLOW.test(v),v);
  for(const v of ['Unfollow','Leave Thread','取消关注','フォローを解除','退出する'])assert.ok(UNFOLLOW.test(v)&&!FOLLOW.test(v),v);
  for(const v of ['Follow @someone','Not Following','关注失败','通知設定'])assert.ok(!FOLLOW.test(v));
});
test('forum view and direct thread detection keep unknown parent null',()=>{
  const a=fake({forum:true}).adapter.inspect();assert.equal(a.type,'forum');assert.equal(a.forumId,F);
  const b=fake().adapter.inspect();assert.equal(b.type,'thread');assert.equal(b.forumId,null);assert.equal(b.threadId,T);assert.ok(b.originalTitle.length>100);
  const c=fake({known:true}).adapter.inspect();assert.equal(c.forumId,F);
});
test('query thread sidebar keeps clicked explicit parent; never assumes route is parent',()=>{
  const {adapter}=fake({forum:true,query:`?thread=${T}`,sidebar:true});
  assert.equal(adapter.inspect().forumId,null); // route guild/forum by itself is insufficient evidence
  adapter.links.set(`${G}:${T}`,{forumId:F,forumName:'Parent'});
  assert.equal(adapter.inspect().forumId,F);
});
test('ordinary page without thread controls is unknown; already-followed state does not save',()=>{
  const {adapter}=fake({following:true});adapter.controls=()=>[];
  assert.equal(adapter.inspect().type,'unknown');
  let saved=0;adapter.onFollow=()=>saved++;adapter.scan();assert.equal(saved,0);
});
async function followScenario({change=true,navigate=false,remove=false,profileChange=false,revert=false,language='en'}={}) {
  const obj=fake();let saved=0,enabled='profile-school';const timers=[];
  const originalSet=globalThis.setTimeout,originalElement=globalThis.Element;
  class FakeElement{}globalThis.Element=FakeElement;
  const b=Object.assign(new FakeElement(),obj.button);b.textContent=language==='zh'?'关注帖子':language==='ja'?'フォローする':'Follow';
  obj.adapter.controls=()=>[b];obj.adapter.isEnabled=()=>enabled;obj.adapter.onFollow=()=>saved++;
  globalThis.setTimeout=fn=>{timers.push(fn);return timers.length;};
  try {
    const target=Object.assign(new FakeElement(),{closest:()=>b});
    obj.adapter.handleClick({isTrusted:true,composedPath:()=>[],target});
    if(change)b.textContent=language==='zh'?'取消关注':language==='ja'?'フォロー解除':'Unfollow';
    if(navigate)obj.setHref(`https://discord.com/channels/${G}/${F}`);
    if(remove)b.isConnected=false;if(profileChange)enabled='profile-private';
    timers.shift()?.();if(revert)b.textContent='Follow';timers.shift()?.();
    return saved;
  } finally {globalThis.setTimeout=originalSet;globalThis.Element=originalElement;}
}
test('native capture requires stable inverse state, same route/control/profile (simulated DOM)',async()=>{
  assert.equal(await followScenario(),1);
  for(const language of ['zh','ja'])assert.equal(await followScenario({language}),1);
  for(const config of [{change:false},{navigate:true},{remove:true},{profileChange:true},{revert:true}])assert.equal(await followScenario(config),0,JSON.stringify(config));
});
test('untrusted clicks are ignored',()=>{
  const {adapter}=fake();assert.doesNotThrow(()=>adapter.handleClick({isTrusted:false}));assert.equal(adapter.pending,null);
});

test('additional localized joined/following labels are recognized',()=>{
  for(const value of ['Following','Joined Thread','已关注','正在关注','已關注','フォロー中','参加中'])assert.ok(UNFOLLOW.test(value),value);
  assert.ok(FOLLOW.test('Follow Thread'));
});
