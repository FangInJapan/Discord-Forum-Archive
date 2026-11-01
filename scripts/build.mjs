import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const meta=`// ==UserScript==
// @name         Discord Forum Archive
// @namespace    https://github.com/FangInJapan/Discord-Forum-Archive
// @version      1.3.2
// @description  独立保存 Discord 论坛帖子收藏；支持分类、长标题、备份和可调面板。
// @author       FangInJapan
// @match        https://discord.com/channels/*
// @match        https://canary.discord.com/channels/*
// @match        https://ptb.discord.com/channels/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.addValueChangeListener
// @grant        GM.removeValueChangeListener
// @grant        GM.registerMenuCommand
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/FangInJapan/Discord-Forum-Archive
// @supportURL   https://github.com/FangInJapan/Discord-Forum-Archive/issues
// @downloadURL  https://raw.githubusercontent.com/FangInJapan/Discord-Forum-Archive/main/dist/discord-forum-archive.user.js
// @updateURL    https://raw.githubusercontent.com/FangInJapan/Discord-Forum-Archive/main/dist/discord-forum-archive.user.js
// ==/UserScript==
`;
const files=['core.js','discord.js','style.js','app.js','main.js'];
const modules=await Promise.all(files.map(async f=>`\n// ---- ${f} ----\n${(await readFile(resolve(root,'src',f),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')}`));
const output=`${meta}\n(function () {\n'use strict';\n${modules.join('\n')}\n})();\n`;
new vm.Script(output,{filename:'discord-forum-archive.user.js'});
const target=resolve(root,'dist/discord-forum-archive.user.js');
if(process.argv.includes('--check')) {
  if(await readFile(target,'utf8')!==output)throw new Error('dist differs from source; run npm run build');
  console.log('Distribution is reproducible; JavaScript syntax is valid.');
} else {await mkdir(dirname(target),{recursive:true});await writeFile(target,output);console.log(`Built ${Buffer.byteLength(output)} bytes.`);}
