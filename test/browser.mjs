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
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('实验性：原生关注成功后记录本地收藏').check();await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#thread').click();await page.locator('#follow').click();
  await page.getByRole('button',{name:'独立帖子收藏入口'}).waitFor({state:'hidden'});
  await page.getByRole('region',{name:'收藏列表'}).getByRole('link',{name:'父频道未知 · 直接访问帖子',exact:true}).waitFor();
  await page.getByRole('button',{name:'折叠面板',exact:true}).click();await page.getByRole('button',{name:'展开收藏面板',exact:true}).click();
  await page.locator('#theme').click();
  await page.locator('#audit').click();const report=await page.locator('#fixture-log').textContent();assert.ok(!report.includes('FAIL'),report);
  await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/smoke.png'});
  assert.deepEqual(errors,[]);console.log(report);console.log('Browser fixture smoke checks passed. Not a live Discord/Tampermonkey test.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
