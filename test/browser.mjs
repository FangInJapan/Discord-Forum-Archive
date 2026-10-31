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
  await card.getByRole('button',{name:'重新读取标题'}).waitFor({state:'visible'});
  const positions=await card.evaluate(node=>{
    const rect=selector=>{
      const element=node.querySelector(selector);if(!element)return null;
      const box=element.getBoundingClientRect();
      return {x:box.x,y:box.y,width:box.width,height:box.height};
    };
    return {star:rect('.star'),age:rect('.post-age'),title:rect('.card-title'),
      more:rect('.more'),reload:rect('.reload-title')};
  });
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

  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('实验性：原生关注成功后记录本地收藏').check();await page.getByRole('button',{name:'保存设置',exact:true}).click();
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

  await page.getByRole('button',{name:'折叠面板',exact:true}).click();await page.getByRole('button',{name:'展开收藏面板',exact:true}).click();
  await page.locator('#theme').click();
  await page.locator('#audit').click();const report=await page.locator('#fixture-log').textContent();assert.ok(!report.includes('FAIL'),report);
  await mkdir('test-output',{recursive:true});
  await page.screenshot({path:'test-output/smoke.png'});
  await page.setViewportSize({width:375,height:812});
  await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().waitFor();
  const compactBounds=await page.getByRole('region',{name:'收藏列表'}).getByRole('article').first().boundingBox();
  assert.ok(compactBounds&&compactBounds.x>=0&&compactBounds.x+compactBounds.width<=375,'compact cards must remain within a narrow viewport');
  await page.screenshot({path:'test-output/smoke-narrow.png'});
  assert.deepEqual(errors,[]);console.log(report);console.log('Browser fixture smoke checks passed. Not a live Discord/Tampermonkey test.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
