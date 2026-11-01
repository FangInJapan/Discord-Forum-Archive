// Optional real-browser checks against a synthetic DOM; this is never a live Discord test.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {makeFixture} from './make-fixture.mjs';
let playwright;
try {playwright=await import('playwright');}
catch {
  if(!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)throw new Error('Run npm install, then npx playwright install chromium.');
  playwright=createRequire(import.meta.url)(resolve(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright'));
}
const fixture=await makeFixture();const html=await readFile(fixture);
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {
  browser=await playwright.chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('新资料库名称').fill('Browser Test');await page.getByRole('button',{name:'创建并使用',exact:true}).click();
  await page.getByRole('link',{name:/教程2｜/}).click();await page.getByRole('button',{name:'一键收藏当前帖子',exact:true}).click();
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').waitFor();
  assert.equal(await page.locator('article.card').count(),1);
  await page.getByRole('button',{name:'切换星标',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'切换星标',exact:true}).getAttribute('aria-pressed'),'true');
  // Compact-card hierarchy: left stack (star/time), central title, right stack (more/refresh).
  const card=page.getByRole('region',{name:'收藏列表'}).getByRole('article').first();
  const handle=await page.waitForFunction(()=>{
    const node=document.querySelector('#dfa-root')?.shadowRoot?.querySelector('article.compact-card');
    if(!node||!node.isConnected)return false;
    const rect=selector=>{
      const el=node.querySelector(selector);if(!el)return null;
      const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};
    };
    const positions={star:rect('.star'),age:rect('.post-age'),title:rect('.card-title'),
      more:rect('.more'),reload:rect('.reload-title')};
    return Object.values(positions).every(b=>b&&b.width>0&&b.height>0)?positions:false;
  },null,{timeout:10000});
  const positions=await handle.jsonValue();
  const {star:starBox,age:ageBox,title:titleBox,more:moreBox,reload:reloadBox}=positions;
  assert.ok([starBox,ageBox,titleBox,moreBox,reloadBox].every(box=>box&&box.width>0&&box.height>0),
    'all compact-card controls must be rendered: '+JSON.stringify(positions));
  assert.ok(ageBox.y>=starBox.y+starBox.height-1,'timestamp must appear below star');
  assert.ok(reloadBox.y>=moreBox.y+moreBox.height-1,'refresh must appear below ellipsis');
  assert.ok(titleBox.x>starBox.x&&moreBox.x>titleBox.x,'title occupies central column');
  await card.getByRole('button',{name:'帖子更多操作'}).click();
  const actions=page.getByRole('dialog',{name:'帖子操作'});
  await actions.waitFor();
  assert.equal(await actions.getByRole('button',{name:'重新读取标题'}).count(),0,'refresh is no longer duplicated in the overflow menu');
  await page.keyboard.press('Escape');
  await card.getByRole('button',{name:'重新读取标题'}).click();

  // A loaded forum card can have /guild/forum/thread URL and visible preview.
  // Refresh must detect its updated heading WITHOUT entering the post.
  await page.locator('#forum').click();
  await page.waitForFunction(()=>window.fixtureApp.context.type==='forum');
  await page.evaluate(async()=>{
    const app=window.fixtureApp;
    await app.store.add(makeRecord({guildId:'111111111111111111',
      threadId:'444444444444444444',forumId:'222222222222222222',
      originalTitle:'教程10｜数字电子技术'},'manual-link'));
    // A saved, currently unrendered thread in the scanned forum is missing;
    // one in another forum must never be classified as missing.
    await app.store.add(makeRecord({guildId:'111111111111111111',
      threadId:'555555555555555555',forumId:'222222222222222222',
      originalTitle:'当前论坛尚未加载的旧帖'},'manual-link'));
    await app.store.add(makeRecord({guildId:'111111111111111111',
      threadId:'999999999999999999',forumId:'777777777777777777',
      originalTitle:'其他论坛未扫描帖子'},'manual-link'));
  });
  await page.locator('#rename-card').click();
  await page.waitForFunction(()=>{
    const app=window.fixtureApp;
    return app.adapter.collectVisiblePosts().some(
      p=>p.threadId==='444444444444444444'&&p.originalTitle==='教程10｜标题已经在论坛列表中变化'
    );
  });
  await page.getByRole('button',{name:'刷新当前页面可见收藏的标题'}).click();
  await page.waitForFunction(()=>{
    const r=window.fixtureApp.store.records.get('111111111111111111:444444444444444444');
    return r?.originalTitle==='教程10｜标题已经在论坛列表中变化'&&r?.changeUnread===true;
  });
  const renamed=await page.evaluate(()=>window.fixtureApp.store.records.get('111111111111111111:444444444444444444'));
  assert.equal(renamed.previousSeenTitle,'教程10｜数字电子技术');
  assert.equal(renamed.originalTitle,'教程10｜标题已经在论坛列表中变化');
  assert.ok(!renamed.originalTitle.includes('帖子预览消息内容'));
  const view=page.getByRole('tablist',{name:'收藏筛选'});
  assert.equal(await view.getByRole('tab').count(),3);
  await view.getByRole('tab',{name:'未检测到'}).click();
  await page.getByRole('region',{name:'收藏列表'}).getByRole('link',{name:'当前论坛尚未加载的旧帖'}).waitFor();
  assert.equal(await page.getByRole('region',{name:'收藏列表'}).getByRole('link',{name:'其他论坛未扫描帖子'}).count(),0,
    'unscanned other forum must never enter missing mode');
  const scan=await page.evaluate(()=>window.fixtureApp.prefs.scanResults['111111111111111111:222222222222222222']);
  assert.deepEqual(scan.missing,['555555555555555555']);
  await view.getByRole('tab',{name:'全部'}).click();
  await page.waitForFunction(()=>window.fixtureApp.currentFilter().updates==='all');
  assert.equal(await page.getByRole('region',{name:'收藏列表'}).getByRole('link',{name:'其他论坛未扫描帖子'}).count(),1,
    'All view must cover saved posts across forums in the current server');
  await page.evaluate(()=>window.fixtureApp.store.patch('111111111111111111:444444444444444444',{changeUnread:false}));
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().waitFor();


  // Observed title changes appear only in the new '最近更新' filter.
  await page.evaluate(async()=>{
    await window.fixtureApp.store.observe({
      guildId:'111111111111111111',threadId:'333333333333333333',originalTitle:'已确认更名的论坛帖子'
    });
  });
  const updateTab=view.getByRole('tab',{name:'更新',exact:true});
  await updateTab.click();
  assert.equal(await updateTab.getAttribute('aria-pressed'),'true');
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().waitFor();
  assert.equal(await page.locator('article.title-changed').count(),1);
  await page.getByRole('button',{name:'帖子更多操作'}).click();
  await page.getByRole('dialog',{name:'帖子操作'}).getByRole('button',{name:'标记标题变化为已查看'}).click();
  await page.getByRole('region',{name:'收藏列表'}).getByText('目前没有尚未查看的标题变化。').waitFor();
  await view.getByRole('tab',{name:'全部'}).click();
  await page.waitForFunction(()=>window.fixtureApp.currentFilter().updates==='all');
  assert.equal(await updateTab.getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Forum Archive 设置'});
  await settings.getByRole('tab',{name:'外观'}).waitFor();
  assert.equal(await settings.getByLabel('玻璃质感与柔和高光').isChecked(),true);
  await settings.getByRole('tab',{name:'收藏'}).click();
  await page.getByLabel('自动记录已确认的原生关注').check();await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#thread').click();await page.locator('#follow').click();
  await page.waitForFunction(()=>window.fixtureApp.store.records.has('111111111111111111:666666666666666666'));
  await page.waitForFunction(()=>window.fixtureApp.currentFilter().updates==='all');
  await page.getByRole('button',{name:'独立帖子收藏入口'}).waitFor({state:'hidden'});
  await page.getByRole('region',{name:'收藏列表'}).getByRole('link',{name:'父频道未知 · 直接访问帖子',exact:true}).waitFor();
  // Focus is inside the userscript's Shadow DOM; Discord's document-level
  // keyboard shortcuts must not steal input into its post composer.
  const composer=page.locator('#discord-composer');
  const search=page.getByRole('searchbox',{name:'搜索收藏'});
  await search.click();await search.pressSequentially('test123');
  assert.equal(await search.inputValue(),'test123');
  assert.equal(await composer.textContent(),'','search typing leaked to Discord composer');
  await page.getByRole('button',{name:'添加帖子链接'}).click();
  const linkField=page.getByRole('textbox',{name:'帖子链接'});
  await linkField.pressSequentially('https://discord.com/channels/111111111111111111/333333333333333333');
  assert.ok((await linkField.inputValue()).startsWith('https://'));
  assert.equal(await composer.textContent(),'','dialog typing leaked to Discord composer');
  await page.keyboard.press('Escape');
  await composer.click();await page.keyboard.type('outside');
  assert.equal(await composer.textContent(),'outside','Discord editor should still type normally');
  await search.fill('');

  await page.getByRole('button',{name:'折叠面板',exact:true}).click();
  await page.getByRole('button',{name:'展开收藏面板',exact:true}).waitFor();
  await page.locator('#forum').click();
  await page.waitForFunction(()=>window.fixtureApp.context.type==='forum');
  assert.equal(await page.getByRole('button',{name:'展开收藏面板'}).isVisible(),true,'manual collapsed mode survives opening forum');
  await page.locator('#thread').click();
  await page.waitForFunction(()=>window.fixtureApp.context.type==='thread');
  assert.equal(await page.getByRole('button',{name:'展开收藏面板'}).isVisible(),true,'manual collapsed mode survives thread navigation');
  await page.getByRole('button',{name:'展开收藏面板',exact:true}).click();
  await page.getByRole('button',{name:'折叠面板',exact:true}).waitFor();
  await page.locator('#forum').click();
  await page.waitForFunction(()=>window.fixtureApp.context.type==='forum');
  assert.equal(await page.getByRole('button',{name:'折叠面板'}).isVisible(),true,'manual expanded mode survives forum navigation');
  await page.locator('#thread').click();
  await page.waitForFunction(()=>window.fixtureApp.context.type==='thread');
  assert.equal(await page.getByRole('button',{name:'折叠面板'}).isVisible(),true,'manual expanded mode survives thread navigation');
  // Manual recognition without any forum-specific CSS or create-post controls.
  // The synthetic forum card deliberately carries data-thread-id to guard
  // against the old false sidebar detection.
  await page.locator('#unrecognized').click();
  await page.waitForFunction(()=>window.fixtureApp.adapter.inspect().type==='unknown');
  await page.getByRole('button',{name:'刷新当前页面可见收藏的标题'}).click();
  const recognizer=page.getByRole('dialog',{name:'确认频道类型'});
  await recognizer.waitFor();
  await page.evaluate(async()=>{
    await window.fixtureApp.store.add(makeRecord({
      guildId:'111111111111111111',forumId:'888888888888888888',
      threadId:'999999999999999999',originalTitle:'保存的旧帖子标题'
    },'manual-link'));
  });
  await recognizer.getByRole('button',{name:'确认当前频道是论坛'}).click();
  await page.waitForFunction(()=>{
    const app=window.fixtureApp;
    const entry=app.prefs.knownForums['111111111111111111:888888888888888888'];
    const post=app.store.records.get('111111111111111111:999999999999999999');
    return entry?.source==='manual'&&entry?.kind==='forum'&&
      post?.originalTitle==='已更新的活跃帖子标题'&&post.changeUnread===true;
  });
  await page.locator('#forum').click();
  await page.waitForFunction(()=>window.fixtureApp.adapter.inspect().forumId==='222222222222222222');
  await page.locator('#unrecognized').click();
  await page.waitForFunction(()=>window.fixtureApp.adapter.inspect().type==='forum');
  await page.locator('.context').click();
  await page.getByRole('dialog',{name:'修改显示名称'}).getByRole('button',{name:'频道类型识别 / 修正'}).click();
  await page.getByRole('dialog',{name:'确认频道类型'}).getByRole('button',{name:'这不是论坛（纠正误识别）'}).click();
  await page.waitForFunction(()=>window.fixtureApp.adapter.inspect().type!=='forum'&&
    window.fixtureApp.prefs.knownForums['111111111111111111:888888888888888888']?.kind==='not-forum');
  await page.locator('.context').click();
  await page.getByRole('dialog',{name:'修改显示名称'}).getByRole('button',{name:'频道类型识别 / 修正'}).click();
  await page.getByRole('dialog',{name:'确认频道类型'}).getByRole('button',{name:'确认当前频道是论坛'}).click();
  await page.waitForFunction(()=>window.fixtureApp.adapter.inspect().type==='forum');
  await page.locator('#theme').click();
  await page.locator('#audit').click();const report=await page.locator('#fixture-log').textContent();assert.ok(!report.includes('FAIL'),report);
  await mkdir('test-output',{recursive:true});
  await page.screenshot({path:'test-output/smoke.png'});
  await page.setViewportSize({width:375,height:812});
  await page.waitForFunction(()=>{
    const panel=window.fixtureApp.panel.getBoundingClientRect();
    return panel.left>=0&&panel.right<=innerWidth+1;
  });
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().waitFor();
  const compactBounds=await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().boundingBox();
  assert.ok(compactBounds&&compactBounds.x>=0&&compactBounds.x+compactBounds.width<=375,
    'compact cards must remain within a narrow viewport: '+JSON.stringify(compactBounds));
  await page.screenshot({path:'test-output/smoke-narrow.png'});
  assert.deepEqual(errors,[]);console.log(report);console.log('Browser fixture smoke checks passed. Not a live Discord/Tampermonkey test.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
