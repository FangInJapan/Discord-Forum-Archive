import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function makeFixture() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const code=(await Promise.all(['core.js','discord.js','style.js','app.js'].map(f=>readFile(resolve(root,'src',f),'utf8')))).join('\n').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Forum Archive · 模拟页面验收</title>
  <style>:root{--background-primary:#242429;--background-secondary:#2e2e35;--text-normal:#f2f3f5;--text-muted:#bbbcc7;--background-modifier-accent:#555560;--brand-500:#5865f2;--background-modifier-hover:#3b3b43}body{background:var(--background-primary);color:var(--text-normal);font:16px Arial;margin:30px}button,a{color:inherit;font:inherit;padding:8px;cursor:pointer}button{background:var(--background-secondary);border:1px solid #777;border-radius:8px}main{max-width:650px;margin:28px 0;background:var(--background-primary)}main a{display:block;border:1px solid #666;border-radius:8px;margin:12px 0;text-decoration:none;overflow-wrap:anywhere}main a h2{font-size:18px}#fixture-controls{display:flex;gap:8px;flex-wrap:wrap;max-width:650px}#fixture-log{white-space:pre-wrap;max-width:650px}header h1{font-size:24px}</style>
  <h1>Forum Archive / 模拟验收环境</h1><p>本页是可控的测试夹具，不是真实 Discord。只使用本页的浏览器本地测试存储。</p>
  <div id="fixture-controls"><button id="forum">论坛列表</button><button id="unrecognized">未识别的论坛</button><button id="thread">直接打开未知父论坛帖子</button><button id="failed">关注失败场景</button><button id="plain">普通频道</button><button id="dm">私信</button><button id="theme">切换主题</button><button id="audit">运行界面检查</button><button id="rename-card">修改列表可见标题</button><button id="seed">装入 500 条测试收藏</button><button id="quota">模拟存储失败</button><button id="show">恢复面板</button></div>
  <main></main><pre id="fixture-log" role="status"></pre>
  <script>${code}
  const G='111111111111111111',F='222222222222222222',T='333333333333333333',U='444444444444444444';
  const longTitle='教程2｜電気工学の資料整理と実験結果の相談・中文长标题测试 '+ '日本語 Chinese English 🧪 1234567890 '.repeat(5);
  let href='https://discord.com/channels/'+G+'/'+F,fail=false,writeFail=false,bright=false;
  const main=document.querySelector('main'),log=document.querySelector('#fixture-log');
  const storage={get:async(k,d)=>{const v=localStorage.getItem(k);return v===null?d:JSON.parse(v);},set:async(k,v)=>{if(writeFail)throw new Error('模拟：存储空间不足');localStorage.setItem(k,JSON.stringify(v));},list:async()=>Object.keys(localStorage),listen:async(k,fn)=>{const cb=e=>{if(e.key===k)fn();};window.addEventListener('storage',cb);return cb;},unlisten:cb=>window.removeEventListener('storage',cb),menu:()=>{}};
  let secondTitle='教程10｜数字电子技术';
  function showForum(){href='https://discord.com/channels/'+G+'/'+F;main.replaceChildren(element('header',{},element('h1',{text:'電気工学 · 论坛资料'})),element('button',{text:'创建帖子'}));const list=element('div',{'data-list-id':'forum-channel-list'});for(const [id,title] of [[T,longTitle],[U,secondTitle]])list.append(element('article',{class:'forumPostCard'},element('a',{href:'https://discord.com/channels/'+G+'/'+(id===U?F+'/':'')+id,onclick:e=>{e.preventDefault();showThread(id,title);}},element('h2',{text:title}),element('p',{text:'帖子预览消息内容，不是标题'}))));main.append(list);}

  const UF='888888888888888888',UT='999999999999999999';
  function showUnrecognizedForum(){
    href='https://discord.com/channels/'+G+'/'+UF;
    main.replaceChildren(element('header',{},element('h1',{text:'待识别的论坛 · 资源区'})));
    const list=element('div',{class:'generic-list'});
    list.append(element('article',{'data-thread-id':UT},
      element('a',{href:'https://discord.com/channels/'+G+'/'+UF+'/'+UT},
        element('h2',{text:'已更新的活跃帖子标题'}),
        element('p',{text:'这里是帖子正文预览，不应被识别为标题。'}))));
    main.append(list);
  }
  function showThread(id=T,title=longTitle){href='https://discord.com/channels/'+G+'/'+id;main.replaceChildren(element('header',{},element('h1',{text:title}),element('button',{id:'follow',text:'关注帖子',onclick:e=>{if(!fail)setTimeout(()=>e.target.textContent='取消关注',180);}})),element('p',{text:'这是模拟帖子内容。脚本仅使用可见标题和按钮状态。'}),element('div',{id:'discord-composer',role:'textbox',contenteditable:'true','aria-label':'Discord 帖子编辑器'}));}
  showForum();window.fixtureShowThread=showThread;const app=new ArchiveApp(storage,()=>href);app.start().catch(e=>log.textContent=e.stack);window.fixtureApp=app;
  // Simulate a Discord global shortcut handler that mistakes Shadow DOM's host
  // for a non-editable key target. Capture runs before the userscript's root.
  document.addEventListener('keydown',e=>{
    const editor=main.querySelector('#discord-composer');
    if(editor&&e.key.length===1&&e.target?.id==='dfa-root'&&!e.target.isContentEditable)editor.textContent+=e.key;
  },true);
  document.querySelector('#rename-card').onclick=()=>{
    secondTitle='教程10｜标题已经在论坛列表中变化';
    const card=main.querySelector('a[href$="/'+F+'/'+U+'"] h2');
    if(card)card.textContent=secondTitle;
  };
  document.querySelector('#unrecognized').onclick=()=>{fail=false;showUnrecognizedForum();};
  document.querySelector('#forum').onclick=()=>{fail=false;showForum();};document.querySelector('#thread').onclick=()=>{fail=false;showThread('666666666666666666','父频道未知 · 直接访问帖子');};
  document.querySelector('#failed').onclick=()=>{fail=true;showThread('777777777777777777','关注失败时不应收藏');};
  document.querySelector('#plain').onclick=()=>{href='https://discord.com/channels/'+G+'/888888888888888888';main.replaceChildren(element('header',{},element('h1',{text:'普通文字频道'})),element('p',{text:'不应误认成论坛。'}));};
  document.querySelector('#dm').onclick=()=>{href='https://discord.com/channels/@me';main.replaceChildren(element('h1',{text:'私信'}));};
  document.querySelector('#theme').onclick=()=>{bright=!bright;document.documentElement.style.cssText=bright?'--background-primary:rgb(255,255,255);--background-secondary:rgb(242,243,245);--text-normal:rgb(32,33,39);--text-muted:rgb(83,84,96);--background-modifier-accent:rgb(185,187,197)':'';document.documentElement.classList.toggle('theme-light',bright);};
  document.querySelector('#quota').onclick=()=>{writeFail=!writeFail;log.textContent='存储失败模拟：'+writeFail;};document.querySelector('#show').onclick=()=>app.setMode('expanded',true);
  document.querySelector('#seed').onclick=async()=>{if(!app.store)return;const now=performance.now();for(let i=0;i<500;i++)await app.store.add(makeRecord({guildId:G,threadId:String(900000000000000000n+BigInt(i)),forumId:F,forumName:'電気工学 · 论坛资料',originalTitle:'教程'+i+' '+longTitle},'manual-link'));log.textContent='已装入 500 条测试收藏，用时 '+Math.round(performance.now()-now)+' ms';};
  document.querySelector('#audit').onclick=async()=>{const results=[],check=(label,value)=>results.push((value?'PASS ':'FAIL ')+label);await app.sync();const host=document.querySelector('#dfa-root');check('面板只挂载一次',document.querySelectorAll('#dfa-root').length===1);check('Shadow DOM 样式隔离',!!host?.shadowRoot);check('页面没有横向溢出',document.documentElement.scrollWidth<=innerWidth);check('同一资料库记录无重复身份',new Set([...app.store.records.values()].map(identity)).size===app.store.records.size);check('已知长标题完整保存',[...app.store.records.values()].filter(r=>r.originalTitle.startsWith('教程2｜')).every(r=>r.originalTitle===normalizeThreadTitle(longTitle)));const p=app.panel.getBoundingClientRect();check('面板完整位于视口',app.panel.hidden||(p.left>=0&&p.top>=0&&p.right<=innerWidth+1&&p.bottom<=innerHeight+1));check('没有可执行的用户 HTML',!app.list.querySelector('img,script,iframe'));check('字号设置生效',getComputedStyle(app.host).getPropertyValue('--title-size').trim()===app.prefs.titleSize+'px');log.textContent=results.join('\\n');};
  </script></html>`;
  const path=resolve(root,'test-output/fixture.html');await mkdir(dirname(path),{recursive:true});await writeFile(path,html);return path;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(await makeFixture());
