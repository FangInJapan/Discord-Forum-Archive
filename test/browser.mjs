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

  // Observed title changes appear only in the new '最近更新' filter.
  await page.evaluate(async()=>{
    await window.fixtureApp.store.observe({
      guildId:'111111111111111111',threadId:'333333333333333333',originalTitle:'已确认更名的论坛帖子'
    });
  });
  const updateSwitch=page.getByRole('switch',{name:'全部或最近更新'});
  await updateSwitch.click();
  assert.equal(await updateSwitch.getAttribute('aria-checked'),'true');
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().waitFor();
  assert.equal(await page.locator('article.title-changed').count(),1);
  await page.getByRole('button',{name:'帖子更多操作'}).click();
  await page.getByRole('dialog',{name:'帖子操作'}).getByRole('button',{name:'标记标题变化为已查看'}).click();
  await page.getByRole('region',{name:'收藏列表'}).getByText('目前没有尚未查看的标题变化。').waitFor();
  await updateSwitch.click();
  assert.equal(await updateSwitch.getAttribute('aria-checked'),'false');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Forum Archive 设置'});
  await settings.getByRole('tab',{name:'外观'}).waitFor();
  assert.equal(await settings.getByLabel('玻璃质感与柔和高光').isChecked(),true);
  await settings.getByRole('tab',{name:'收藏'}).click();
  await page.getByLabel('自动记录已确认的原生关注').check();await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#thread').click();await page.locator('#follow').click();
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
