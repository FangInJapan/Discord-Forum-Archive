// ==UserScript==
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

(function () {
'use strict';

// ---- core.js ----
// Pure data layer. No Discord APIs, browser globals, or whole-database writes.
const VERSION = '1.3.2';
const SCHEMA = 1;
const PREFIX = 'dfa:v1:';
const ID = /^[0-9]{16,22}$/;
const FOLDER_ID = /^(?:default|[\w-]{8,100})$/;
const SOURCES = ['manual-page', 'manual-link', 'native-follow', 'import'];
const SORTS = ['saved-desc', 'saved-asc', 'modified-desc', 'modified-asc', 'title-asc', 'title-desc', 'starred'];
const DEFAULTS = Object.freeze({
  theme: 'discord', titleSize: 15, uiSize: 13, lines: 4, density: 'standard',
  snap: true, hover: false, autoFollow: true, debug: false, autoOpen: true, glass: true, motion: true,
  defaultScope: 'forum', defaultSort: 'saved-desc', mode: 'expanded',
  width: 460, height: 580, x: 1, y: 0.15, dock: 'right', filters: {}, scanResults: {},
  folders: [{id:'default',name:'默认收藏夹'}], folderSelections: {}, guildAliases: {}, forumAliases: {}, knownForums: {}
});
function uid() { return crypto.randomUUID(); }
function canonical(guildId, threadId) { return `https://discord.com/channels/${guildId}/${threadId}`; }
function identity(r) { return `${r.guildId}:${r.threadId}`; }
function parseLink(value) {
  let u;
  try { u = new URL(value.trim()); } catch { throw new Error('请输入完整的 https://discord.com/channels/… 帖子链接。'); }
  if (u.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com', 'discordapp.com'].includes(u.hostname) || u.port || u.username || u.password)
    throw new Error('只接受 Discord 官方域名的 HTTPS 频道或帖子永久链接。');
  const m = u.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/(\d+))?\/?$/);
  if (!m || !ID.test(m[1]) || !ID.test(m[2]) || (m[3] && !ID.test(m[3])))
    throw new Error('链接需含服务器 ID 和帖子频道 ID；不支持私信、邀请和只有消息 ID 的链接。');
  return { guildId: m[1], threadId: m[2], messageId: m[3] || null, url: canonical(m[1], m[2]) };
}
function string(value, name, max = 20000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} 字段类型或长度不合法。`);
  return value;
}
function time(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new Error(`${name} 时间不合法。`);
  return value;
}
function validateRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('收藏记录格式错误。');
  for (const k of ['guildId', 'threadId']) if (typeof raw[k] !== 'string' || !ID.test(raw[k])) throw new Error(`${k} 必须是 Snowflake 字符串。`);
  if (raw.forumId !== null && (typeof raw.forumId !== 'string' || !ID.test(raw.forumId) || raw.forumId === raw.threadId)) throw new Error('父论坛 ID 不合法，或与帖子 ID 相同。');
  if (raw.collectionId !== undefined && (typeof raw.collectionId !== 'string' || !FOLDER_ID.test(raw.collectionId))) throw new Error('收藏夹 ID 不合法。');
  if (typeof raw.starred !== 'boolean' || !SOURCES.includes(raw.source)) throw new Error('星标或来源字段不合法。');
  if (!['unknown', 'following'].includes(raw.nativeFollowState)) throw new Error('关注状态字段不合法。');
  return {
    guildId: raw.guildId, threadId: raw.threadId, forumId: raw.forumId,
    guildName: string(raw.guildName ?? '', '服务器名称', 500),
    forumName: string(raw.forumName ?? '', '论坛名称', 500),
    originalTitle: string(raw.originalTitle, '原始标题'),
    customTitle: raw.customTitle === null ? null : string(raw.customTitle, '自定义标题'),
    url: canonical(raw.guildId, raw.threadId), savedAt: time(raw.savedAt, '收藏'),
    modifiedAt: time(raw.modifiedAt, '修改'), lastObservedAt: raw.lastObservedAt === null ? null : time(raw.lastObservedAt, '观察'),
    source: raw.source, starred: raw.starred, nativeFollowState: raw.nativeFollowState,
    collectionId: raw.collectionId ?? 'default',
    titleUpdatedAt: raw.titleUpdatedAt == null ? null : time(raw.titleUpdatedAt,'标题更新时间'),
    previousSeenTitle: raw.previousSeenTitle == null ? null : string(raw.previousSeenTitle,'上一次帖子标题'),
    titleChangedAt: raw.titleChangedAt == null ? null : time(raw.titleChangedAt,'标题变化时间'),
    changeUnread: raw.changeUnread === undefined ? false : (typeof raw.changeUnread === 'boolean' ? raw.changeUnread : (()=>{throw new Error('标题变更状态不合法。');})())
  };
}
function makeRecord(info, source = 'manual-link', now = Date.now()) {
  return validateRecord({ guildId: info.guildId, threadId: info.threadId,
    forumId: info.forumId || null, guildName: info.guildName || '', forumName: info.forumName || '',
    originalTitle: info.originalTitle || `帖子 ${info.threadId}`, customTitle: null,
    savedAt: now, modifiedAt: now, lastObservedAt: source === 'manual-page' || source === 'native-follow' ? now : null,
    source, starred: false, nativeFollowState: source === 'native-follow' ? 'following' : 'unknown',
    collectionId: info.collectionId || 'default', titleUpdatedAt: info.originalTitle ? now : null, previousSeenTitle:null, titleChangedAt:null, changeUnread:false });
}
function validatePatch(raw) {
  const allowed = ['forumId', 'forumName', 'guildName', 'originalTitle', 'customTitle', 'starred', 'lastObservedAt', 'nativeFollowState','collectionId','titleUpdatedAt','previousSeenTitle','titleChangedAt','changeUnread'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('修改字段不合法。');
  const out = {};
  for (const [k,v] of Object.entries(raw)) {
    if (k === 'forumId') { if (v !== null && (typeof v !== 'string' || !ID.test(v))) throw new Error('父频道 ID 不合法。'); }
    else if (k === 'starred' || k === 'changeUnread') { if (typeof v !== 'boolean') throw new Error('布尔值字段格式错误。'); }
    else if (k === 'lastObservedAt' || k === 'titleUpdatedAt' || k === 'titleChangedAt') { if (v !== null) time(v, k); }
    else if (k === 'collectionId') { if(typeof v !== 'string' || !FOLDER_ID.test(v)) throw new Error('收藏夹 ID 不合法。'); }
    else if (k === 'nativeFollowState') { if (!['unknown', 'following'].includes(v)) throw new Error('状态格式错误。'); }
    else if (!(k === 'customTitle' && v === null) && !(k === 'previousSeenTitle' && v===null)) string(v, k, k.endsWith('Name') ? 500 : 20000);
    out[k] = v;
  }
  return out;
}
function validateOperation(op) {
  if (!op || op.schemaVersion !== SCHEMA || typeof op.id !== 'string' || !/^[\w-]{8,100}$/.test(op.id) ||
    !Array.isArray(op.stamp) || op.stamp.length !== 3 || !Number.isSafeInteger(op.stamp[0]) || op.stamp[0] < 0 ||
    !Number.isSafeInteger(op.stamp[1]) || op.stamp[1] < 0 || typeof op.stamp[2] !== 'string' || !/^[\w-]{8,100}$/.test(op.stamp[2]) ||
    typeof op.target !== 'string' || !/^\d{16,22}:\d{16,22}$/.test(op.target) || !['put','capture','patch','delete'].includes(op.kind)) throw new Error('变更记录损坏或版本不兼容。');
  if (op.kind === 'put' || op.kind === 'capture') { if (identity(validateRecord(op.value)) !== op.target) throw new Error('记录身份不一致。'); }
  if (op.kind === 'patch') { const p = validatePatch(op.value); if (p.forumId === op.target.split(':')[1]) throw new Error('父论坛不能是帖子自身。'); }
  return op;
}
function compareStamp(a,b) { return a.stamp[0]-b.stamp[0] || a.stamp[1]-b.stamp[1] || a.stamp[2].localeCompare(b.stamp[2]) || a.id.localeCompare(b.id); }
function reduceOperations(ops) {
  const records = new Map(), deleted = new Set();
  for (const op of [...ops].sort(compareStamp)) {
    if (op.kind === 'delete') { records.delete(op.target);deleted.add(op.target);continue; }
    if (op.kind === 'put' || op.kind === 'capture') {
      if(op.kind === 'put')deleted.delete(op.target);
      if(!records.has(op.target) && !deleted.has(op.target))records.set(op.target,validateRecord(op.value));
      continue;
    }
    const r = records.get(op.target);
    // Observations/edits after deletion cannot resurrect a bookmark.
    if (r) records.set(op.target, { ...r, ...validatePatch(op.value), modifiedAt: Math.max(r.modifiedAt, op.stamp[0]) });
  }
  return records;
}
class ArchiveStore {
  constructor(storage, profileId, onChange = () => {}) {
    if (!/^[\w-]{8,100}$/.test(profileId)) throw new Error('资料库 ID 不合法。');
    this.storage = storage; this.profileId = profileId; this.onChange = onChange;
    this.prefix = `${PREFIX}op:${profileId}:`; this.ops = new Map(); this.records = new Map();
    this.actor = uid(); this.clock = [0,0]; this.invalidCount = 0;
  }
  async refresh() {
    const keys = (await this.storage.list()).filter(k => k.startsWith(this.prefix));
    let changed = false; let invalid = 0;
    for (const key of keys) {
      if (this.ops.has(key)) continue;
      const raw = await this.storage.get(key, null);
      try { const op = validateOperation(raw); if (key !== this.prefix + op.id) throw new Error('key'); this.ops.set(key, op); changed = true; }
      catch { invalid++; }
    }
    this.invalidCount = invalid;
    if (changed) { this.records = reduceOperations(this.ops.values()); this.onChange(); }
    return this.records;
  }
  nextStamp() {
    let remote = [0,0];
    for (const o of this.ops.values()) if (o.stamp[0] > remote[0] || (o.stamp[0] === remote[0] && o.stamp[1] > remote[1])) remote = o.stamp;
    const wall = Math.max(Date.now(), this.clock[0], remote[0]);
    const count = wall === Math.max(this.clock[0], remote[0]) ? Math.max(this.clock[0] === wall ? this.clock[1] : 0, remote[0] === wall ? remote[1] : 0)+1 : 0;
    this.clock = [wall,count]; return [wall,count,this.actor];
  }
  async write(kind,target,value) {
    await this.refresh();
    const op = { schemaVersion: SCHEMA, id: uid(), stamp: this.nextStamp(), kind, target, ...(value === undefined ? {} : { value }) };
    validateOperation(op);
    const key = this.prefix + op.id;
    await this.storage.set(key,op);
    if (JSON.stringify(await this.storage.get(key,null)) !== JSON.stringify(op)) throw new Error('保存校验失败；请保留备份并检查 Tampermonkey 存储。');
    this.ops.set(key,op); this.records = reduceOperations(this.ops.values()); this.onChange();
    // Notification is only a hint. Periodic rescans also discover simultaneous writes.
    try { await this.storage.set(`${PREFIX}pulse`, uid()); } catch { /* durable op already verified */ }
    return this.records.get(target);
  }
  async add(record, {automatic = false} = {}) {
    record = validateRecord(record); await this.refresh();
    if (this.records.has(identity(record))) return this.records.get(identity(record));
    return this.write(automatic?'capture':'put',identity(record),record);
  }
  async patch(target,patch) { return this.write('patch',target,validatePatch(patch)); }
  async remove(target) { return this.write('delete',target); }
  async observe(info,followed = false) {
    await this.refresh(); const r = this.records.get(identity(info));
    if (!r) return null;
    const patch = {};
    if (info.originalTitle && info.originalTitle !== r.originalTitle) {
      const now=Date.now();
      patch.originalTitle = info.originalTitle; patch.titleUpdatedAt = now;
      // Placeholder titles are not proof of an actual Discord title change.
      if (r.originalTitle && r.originalTitle !== `帖子 ${r.threadId}`) {
        patch.previousSeenTitle = r.originalTitle;
        patch.titleChangedAt = now;
        patch.changeUnread = true;
      }
    }
    if (!r.forumId && info.forumId) { patch.forumId = info.forumId; patch.forumName = info.forumName || ''; }
    if (!r.guildName && info.guildName) patch.guildName = info.guildName;
    if (followed && r.nativeFollowState !== 'following') patch.nativeFollowState = 'following';
    if (!Object.keys(patch).length) return r;
    patch.lastObservedAt = Date.now(); return this.patch(identity(r),patch);
  }
}
// Return IDs absent from the *currently rendered* active forum card sample.
// A missing ID means "not detected in this scan", never deleted or inaccessible.
function compareVisibleForum(records,{guildId,forumId,visibleThreadIds,checkedAt=Date.now()}) {
  if(!ID.test(guildId||'')||!ID.test(forumId||''))throw new Error('请进入可识别的论坛频道。');
  const visible=new Set([...visibleThreadIds].filter(id=>typeof id==='string'&&ID.test(id)));
  if(!visible.size)throw new Error('当前没有可识别的活跃帖子卡片，未生成扫描记录。');
  const scoped=[...records].filter(r=>r.guildId===guildId&&r.forumId===forumId);
  return {checkedAt,visibleCount:visible.size,matchedCount:scoped.filter(r=>visible.has(r.threadId)).length,
    missing:scoped.filter(r=>!visible.has(r.threadId)).map(r=>r.threadId)};
}
function selectRecords(records, { guildId, forumId, scope = 'forum', collectionId = null, updates = 'all', missingIds = new Set(), query = '', sort = 'saved-desc' }) {
  const q = query.normalize('NFKC').toLocaleLowerCase();
  const result = [...records].filter(r => r.guildId === guildId && (scope === 'server' || r.forumId === (forumId ?? null)) &&
    (collectionId === null || (r.collectionId || 'default') === collectionId) &&
    (updates !== 'changed' || r.changeUnread === true) &&
    (updates !== 'missing' || missingIds.has(identity(r))) &&
    [r.customTitle || '',r.originalTitle,r.forumName].some(s => s.normalize('NFKC').toLocaleLowerCase().includes(q)));
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  result.sort((a,b) => {
    const title = () => collator.compare(a.customTitle ?? a.originalTitle, b.customTitle ?? b.originalTitle);
    let delta = 0;
    switch(sort) {
      case 'title-asc': delta = title(); break; case 'title-desc': delta = -title(); break;
      case 'saved-asc': delta = a.savedAt-b.savedAt; break; case 'modified-asc': delta = a.modifiedAt-b.modifiedAt; break;
      case 'modified-desc': delta = b.modifiedAt-a.modifiedAt; break;
      case 'starred': delta = Number(b.starred)-Number(a.starred) || b.savedAt-a.savedAt; break;
      default: delta = b.savedAt-a.savedAt;
    }
    return delta || identity(a).localeCompare(identity(b));
  }); return result;
}
function exportData(records, profile, prefs = null) {
  const posts = [...records].map(validateRecord);
  const servers = [...new Map(posts.map(r => [r.guildId,{ guildId:r.guildId,name:r.guildName }])).values()];
  const forums = [...new Map(posts.filter(r=>r.forumId).map(r => [`${r.guildId}:${r.forumId}`,{guildId:r.guildId,forumId:r.forumId,name:r.forumName}])).values()];
  return { format:'discord-forum-archive', schemaVersion:SCHEMA, exportedAt:Date.now(), profile:{id:profile.id,name:profile.name}, servers, forums, records:posts, folders:prefs?.folders || [{id:'default',name:'默认收藏夹'}], guildAliases:prefs?.guildAliases || {}, forumAliases:prefs?.forumAliases || {}, knownForums:validateKnownForums(prefs?.knownForums) };
}
function parseImport(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 10*1024*1024) throw new Error('JSON 最大为 10 MiB。');
  let data; try { data = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 文件。'); }
  if (!data || data.format !== 'discord-forum-archive' || data.schemaVersion !== SCHEMA || !Array.isArray(data.records) || data.records.length > 10000) throw new Error('格式/版本不支持，或记录超过 10,000 条。');
  const records = new Map();
  for (const raw of data.records) { const r = validateRecord(raw); if (!records.has(identity(r))) records.set(identity(r),r); }
  return { records:[...records.values()], duplicates:data.records.length-records.size, profileName: typeof data.profile?.name === 'string' ? data.profile.name.slice(0,100) : '未命名',
    folders:validateFolders(data.folders), guildAliases:validateAliases(data.guildAliases,false),forumAliases:validateAliases(data.forumAliases,true),knownForums:validateKnownForums(data.knownForums) };
}
async function mergeImport(store, records, policy = 'preserve') {
  let added = 0, updated = 0;
  // Validate the entire input before the first write. Storage failures can still cause a partial import.
  records = records.map(validateRecord);
  if (!['preserve','incoming'].includes(policy)) throw new Error('不支持的冲突策略。');
  for (const r of records) {
    await store.refresh(); const old = store.records.get(identity(r));
    if (!old) { await store.add(r); added++; }
    else if (policy === 'incoming') {
      await store.patch(identity(r),{ customTitle:r.customTitle, starred:r.starred, forumId:r.forumId, forumName:r.forumName, guildName:r.guildName, originalTitle:r.originalTitle, collectionId:r.collectionId, titleUpdatedAt:r.titleUpdatedAt,previousSeenTitle:r.previousSeenTitle,titleChangedAt:r.titleChangedAt,changeUnread:r.changeUnread }); updated++;
    }
  }
  return {added,updated};
}
function validateFolders(input) {
  const output=[{id:'default',name:'默认收藏夹'}];
  const seen=new Set(['default']);
  if(!Array.isArray(input))return output;
  for(const folder of input.slice(0,200)) {
    if(!folder||typeof folder.id!=='string'||!FOLDER_ID.test(folder.id)||
      typeof folder.name!=='string'||!folder.name.trim()||folder.name.length>80)continue;
    if(folder.id==='default'){output[0].name=folder.name.trim();continue;}
    if(seen.has(folder.id))continue;
    output.push({id:folder.id,name:folder.name.trim()});seen.add(folder.id);
  }
  return output;
}
function validateAliases(input,forum=false) {
  const result={};
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  const pattern=forum?/^\d{16,22}:\d{16,22}$/:ID;
  for(const [key,value] of Object.entries(input).slice(0,5000)){
    if(pattern.test(key)&&typeof value==='string'&&value.trim()&&value.length<=120)result[key]=value.trim();
  }
  return result;
}
// Confirmed forum IDs are independent of the current Discord DOM and survive SPA transitions.
// The registry is profile-local and never uses user tokens or Discord private APIs.
function validateKnownForums(input) {
  const result={};
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  for(const [key,entry] of Object.entries(input).slice(0,1000)) {
    if(!/^\d{16,22}:\d{16,22}$/.test(key) || !entry || typeof entry!=='object' || Array.isArray(entry))continue;
    if(entry.source!=='manual' && entry.source!=='observed')continue;
    if(entry.kind!==undefined && entry.kind!=='forum' && entry.kind!=='not-forum')continue;
    result[key]={source:entry.source,kind:entry.kind||'forum'};
  }
  return result;
}
function cleanPrefs(raw) {
  const p = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return p;
  for (const [k,opts] of Object.entries({theme:['discord','dark','light'],density:['compact','standard','relaxed'],mode:['expanded','collapsed','hidden'],dock:['none','left','right','top','bottom'],defaultScope:['forum','server'],defaultSort:SORTS})) if (opts.includes(raw[k])) p[k] = raw[k];
  for (const k of ['snap','hover','autoFollow','debug','autoOpen','glass','motion']) if (typeof raw[k] === 'boolean') p[k] = raw[k];
  for (const [k,min,max] of [['titleSize',12,22],['uiSize',11,18],['width',300,760],['height',240,2000],['x',0,1],['y',0,1]]) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) p[k] = Math.max(min,Math.min(max,raw[k]));
  if ([0,1,2,3,4].includes(raw.lines)) p.lines = raw.lines;
  p.filters = {};
  if (raw.filters && typeof raw.filters === 'object') for (const [id,f] of Object.entries(raw.filters)) if (ID.test(id) && f && ['server','forum'].includes(f.scope) && SORTS.includes(f.sort)) p.filters[id] = {scope:'server',sort:f.sort,updates:['all','changed','missing'].includes(f.updates)?f.updates:'all'};
  // Manual scans cover only the forum that was actually shown in Discord.
  // Never infer deletion/invalidity from absence in a partially loaded list.
  p.scanResults={};
  if(raw.scanResults && typeof raw.scanResults==='object' && !Array.isArray(raw.scanResults)){
    for(const [key,scan] of Object.entries(raw.scanResults).slice(-500)){
      if(!/^\d{16,22}:\d{16,22}$/.test(key)||!scan||typeof scan!=='object')continue;
      if(!Number.isSafeInteger(scan.checkedAt)||scan.checkedAt<0||!Number.isSafeInteger(scan.visibleCount)||scan.visibleCount<1)continue;
      const missing=Array.isArray(scan.missing) ? [...new Set(scan.missing.filter(id=>typeof id==='string'&&ID.test(id)))].slice(0,10000) : [];
      p.scanResults[key]={checkedAt:scan.checkedAt,visibleCount:scan.visibleCount,
        matchedCount:Number.isSafeInteger(scan.matchedCount)&&scan.matchedCount>=0?scan.matchedCount:0,missing};
    }
  }
  p.folders=validateFolders(raw.folders);
  p.folderSelections={};
  if(raw.folderSelections&&typeof raw.folderSelections==='object')for(const [guild,id] of Object.entries(raw.folderSelections)) {
    if(ID.test(guild)&&p.folders.some(f=>f.id===id))p.folderSelections[guild]=id;
  }
  p.knownForums=validateKnownForums(raw.knownForums);
  p.guildAliases=validateAliases(raw.guildAliases,false);
  p.forumAliases=validateAliases(raw.forumAliases,true);
  return p;
}
function geometry(p, viewport, collapsed = false) {
  const pad = 8, vw = Math.max(1,viewport.width), vh = Math.max(1,viewport.height);
  const w = collapsed ? Math.min(40,vw) : Math.min(Math.max(300,p.width),760,Math.max(1,vw-pad*2));
  const h = collapsed ? Math.min(112,vh) : Math.min(Math.max(240,p.height),Math.max(1,Math.floor(vh*0.9)),Math.max(1,vh-pad*2));
  const rx = Math.max(0,vw-w-pad*2), ry = Math.max(0,vh-h-pad*2);
  let x = Math.min(pad,vw-w) + rx*p.x, y = Math.min(pad,vh-h) + ry*p.y;
  if (p.dock === 'left') x = 0; if (p.dock === 'right') x = vw-w;
  if (p.dock === 'top') y = 0; if (p.dock === 'bottom') y = vh-h;
  return {x:Math.max(0,x),y:Math.max(0,y),width:w,height:h};
}


// ---- discord.js ----
// Only visible DOM and route information. No webpack stores, token access, or HTTP interception.
const FOLLOW = /^(?:关注(?:帖子|讨论串|此帖)?|加入(?:帖子|讨论串)?|追踪(?:帖子)?)$/;
const UNFOLLOW = /^(?:取消关注(?:帖子|此帖)?|停止关注|已关注|正在关注|退出(?:帖子|讨论串)?|取消加入|已加入|已追踪)$/;
const CREATE = /^(?:新建帖子|创建帖子|发布帖子|发表帖子|发起帖子)$/;
function normalizeThreadTitle(value) {
  const source=String(value||'').replace(/\s+/g,' ').trim();
  // Preserve a closing bracket when Discord appends the Chinese "聊天" UI label.
  let cleaned=source.replace(/[\s|｜·]+聊天$/u,'');
  if(cleaned===source && source.endsWith('】聊天'))cleaned=source.slice(0,-2);
  // Long forum titles may have the UI label appended without a separator.
  if(cleaned===source && source.length>=40 && source.endsWith('聊天'))cleaned=source.slice(0,-2);
  return cleaned.trim() || source;
}
// Forum cards may link to /channels/guild/forum/thread, while permanent thread
// links often use /channels/guild/thread. Treat the third ID as a thread only
// when the second ID is the known, currently rendered forum (never a message).
function visibleForumPostLink(href, context) {
  if(context?.type!=='forum'||!ID.test(context.guildId||'')||!ID.test(context.forumId||''))return null;
  let u;try{u=new URL(href,'https://discord.com');}catch{return null;}
  if(u.protocol!=='https:'||!['discord.com','canary.discord.com','ptb.discord.com','discordapp.com'].includes(u.hostname)||u.port||u.username||u.password)return null;
  const m=u.pathname.match(/^\/channels\/(\d{16,22})\/(\d{16,22})(?:\/(\d{16,22}))?\/?$/);
  if(!m||m[1]!==context.guildId)return null;
  const threadId=m[2]===context.forumId?(m[3]||u.searchParams.get('thread')):m[2];
  if(!threadId||!ID.test(threadId)||threadId===context.forumId)return null;
  // Links whose second ID names a different *forum* cannot be reliably
  // distinguished from a direct thread URI, so callers must use forum cards.
  return {guildId:context.guildId,threadId,url:canonical(context.guildId,threadId)};
}
function controlLabel(el) { return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim(); }
function visible(el) { return !!el && !el.closest('[hidden],[aria-hidden="true"]') && el.getClientRects().length > 0; }
function routeOf(href) {
  try {
    const u = new URL(href); const m = u.pathname.match(/^\/channels\/(@me|\d{16,22})(?:\/(\d{16,22}))?/);
    if (!m || m[1] === '@me') return {type:'dm',guildId:null,channelId:null};
    return {type:'unknown',guildId:m[1],channelId:m[2] || null};
  } catch { return {type:'unknown',guildId:null,channelId:null}; }
}
class DiscordAdapter {
  constructor(doc, onContext, onFollow, isEnabled, log, href = ()=>location.href) {
    this.doc = doc; this.onContext = onContext; this.onFollow = onFollow; this.isEnabled = isEnabled; this.log = log;
    this.context = {type:'unknown'}; this.links = new Map(); this.catalog = new Map(); this.knownThreads = new Map(); this.savedForumRegistry = new Map();
    this.href=href;this.pending = null; this.lastHref = ''; this.signature = ''; this.timer = null; this.followSerial = 0;
    this.menuTarget = null; this.seenExisting = new Set();
    this.click = this.handleClick.bind(this); this.contextMenu = this.handleContextMenu.bind(this); this.scheduled = () => this.schedule();
  }
  main() { return this.doc.querySelector('main,[role="main"]'); }
  forumRoot(main) {
    if(!main)return null;
    return main.querySelector('[data-list-id*="forum"],[data-forum-channel-id]') ||
      (main.querySelector('[class*="forumPost"],[class*="postCard"],[class*="forumChannel"]') ? main : null) ||
      ([...main.querySelectorAll('button,[role="button"]')].some(b => visible(b) && CREATE.test(controlLabel(b))) ? main : null);
  }
  title(root) {
    if (!root) return '';
    const heading = [...root.querySelectorAll('header h1,header h2,header h3,[role="toolbar"] h1,[role="toolbar"] h2,[role="toolbar"] h3,h1,h2')].find(visible);
    return normalizeThreadTitle(heading?.textContent || '');
  }
  controls() {
    const scopes = [...this.doc.querySelectorAll('main header,main [role="toolbar"],[role="main"] header,[role="main"] [role="toolbar"],[role="dialog"] header,[role="dialog"] [role="toolbar"],[class*="threadSidebar"] header,[class*="threadSidebar"] [role="toolbar"],[role="menu"]')];
    return [...new Set(scopes.flatMap(r=>[...r.querySelectorAll('button,[role="button"],[role="menuitem"]')]))]
      .filter(b=>b.isConnected!==false && visible(b) && !b.closest('article,[role="listitem"],[data-list-id="chat-messages"],[id^="chat-messages"]'));
  }
  // A positive joined/following control, not a generic Follow action, is required.
  stateIn(scope) {
    return !!scope && scope.isConnected!==false && [...scope.querySelectorAll('button,[role="button"],[role="menuitem"],[aria-label],[title]')]
      .some(el=>el.isConnected!==false && visible(el) && UNFOLLOW.test(controlLabel(el)));
  }
  // Read only a rendered forum post card associated with an explicit post link.
  postFromNode(node,c=this.context) {
    if(!node?.closest||c.type!=='forum')return null;
    const root=this.forumRoot(this.main())||this.main();
    if(!root||!root.contains(node))return null;
    const selector='article,[role="article"],[role="listitem"],[data-list-item-id],[class*="forumPost"],[class*="postCard"],[class*="card_"]';
    const card=node.closest(selector);
    if(card && !root.contains(card))return null;
    const anchor=node.closest('a[href]');
    const links=[anchor,...(card?[...card.querySelectorAll('a[href]')]:[])].filter(Boolean);
    for(const link of new Set(links)) {
      const parsed=visibleForumPostLink(link.href||link.getAttribute('href'),c);
      if(!parsed)continue;
      // A card's heading is preferable to link text, which may contain
      // preview messages, button labels, or other UI content.
      const scope=card||link;
      const heading=scope.querySelector('h2,h3,h4,[role="heading"],[data-testid*="post-title"],[class*="postTitle"],[class*="threadTitle"],[class*="titleText"],[class*="title_"]');
      const title=normalizeThreadTitle(
        (heading&&visible(heading)?heading.textContent:'') ||
        link.getAttribute('aria-label') || link.getAttribute('title') ||
        (link.children.length===0?link.textContent:'') || ''
      );
      if(!title || /^(?:打开帖子|查看帖子|聊天|消息|更多|回复)$/.test(title))continue;
      return {...parsed,forumId:c.forumId,forumName:c.forumName,guildName:c.guildName,
        originalTitle:title,card:card||link};
    }
    return null;
  }
  collectVisibleFollowed() {
    const c=this.inspect(),root=c.type==='forum'?(this.forumRoot(this.main())||this.main()):null,records=new Map();
    if(!root)return [];
    for(const link of root.querySelectorAll('a[href*="/channels/"]')) {
      if(!visible(link))continue;
      const info=this.postFromNode(link,c);
      if(info && this.stateIn(info.card)) {
        const {card,...record}=info;
        records.set(identity(record),record);
      }
    }
    return [...records.values()];
  }
  collectVisiblePosts() {
    const c=this.inspect(),items=new Map();
    if(c.type==='thread'&&c.originalTitle)items.set(identity(c),c);
    // When a thread is open in Discord's sidebar, its forum cards may still
    // be visible underneath it. Include those cards only with a known parent.
    const route=routeOf(this.href());
    const forumId=c.type==='forum'?c.forumId:(c.type==='thread'?
      (c.forumId||(route.channelId&&route.channelId!==c.threadId?route.channelId:null)):null);
    const root=this.forumRoot(this.main()) || (c.type==='forum'?this.main():null);
    if(forumId && root){
      const forumContext={type:'forum',guildId:c.guildId,forumId,forumName:c.forumName||'',guildName:c.guildName||''};
      for(const link of root.querySelectorAll('a[href*="/channels/"]')){
        if(!visible(link))continue;
        const info=this.postFromNode(link,forumContext);
        if(info?.originalTitle){const {card,...record}=info;items.set(identity(record),record);}
      }
    }
    return [...items.values()];
  }
  visiblePostInfo(key) { return this.collectVisiblePosts().find(p=>identity(p)===key)||null; }
  handleContextMenu(event) {
    if(!event.isTrusted)return;
    const target=event.target instanceof Element?event.target:event.target?.parentElement;
    const info=this.postFromNode(target);
    this.menuTarget=info?{info,at:Date.now()}:null;
  }
  seed(records) {
    this.catalog.clear(); this.knownThreads.clear();
    for (const r of records) {
      this.knownThreads.set(identity(r),r);
      if (r.forumId) this.catalog.set(`${r.guildId}:${r.forumId}`,{guildId:r.guildId,forumId:r.forumId,forumName:r.forumName,guildName:r.guildName});
    }
  }
  setKnownForums(registry={}) {
    this.savedForumRegistry=new Map(Object.entries(registry||{}));
    if(this.observer)this.schedule();
  }
  forumRegistration(guildId,forumId) {
    return this.savedForumRegistry.get(guildId+':'+forumId)||null;
  }
  inspect() {
    const route = routeOf(this.href()), main = this.main();
    if (!route.guildId || !route.channelId) return route;
    const root = this.forumRoot(main);
    const registry=this.forumRegistration(route.guildId,route.channelId);
    const explicitNotForum=registry?.kind==='not-forum';
    const registeredForum=registry?.kind==='forum';
    const knownForum=!explicitNotForum && (registeredForum ? {
      guildId:route.guildId,forumId:route.channelId,forumName:''
    } : this.catalog.get(route.guildId+':'+route.channelId));
    // A thread selected in a visible side panel overrides the underlying forum.
    const sidebar = [...this.doc.querySelectorAll('[class*="threadSidebar"],[role="complementary"][data-thread-id]')]
      .find(el=>visible(el) && !el.closest('[class*="forumPost"],[class*="postCard"],article'));
    const candidate = new URL(this.href()).searchParams.get('thread') || sidebar?.getAttribute('data-thread-id');
    const candidateId = candidate && ID.test(candidate) ? candidate : null;
    const known = this.knownThreads.get(route.guildId+':'+(candidateId || route.channelId));
    const captured = this.links.get(route.guildId+':'+(candidateId || route.channelId));
    const follows = this.controls().filter(b=>!b.closest('[role="menu"]') && (FOLLOW.test(controlLabel(b)) || UNFOLLOW.test(controlLabel(b))));
    const threadMarkup = !!main?.querySelector('[class*="threadChat"],[data-list-id="chat-messages"],[id^="chat-messages"]');
    // Explicit forum registration takes precedence over weak thread heuristics
    // for the bare guild/channel route, but never over a selected thread ID.
    const isThread=!!(candidateId || (!registeredForum && (
      (known && !root) || captured || (follows.length && !root) || (threadMarkup && !root)
    )));
    const guildAnchor = [...this.doc.querySelectorAll('nav a[aria-label],[role="tree"] a[aria-label]')].find(a=>a.getAttribute('href') === `/channels/${route.guildId}`);
    const guildName = guildAnchor?.getAttribute('aria-label') || known?.guildName || captured?.guildName || '';
    if (isThread) {
      const threadId = candidateId || route.channelId;
      const parent = known?.forumId ? known : captured;
      return {...route,type:'thread',threadId,forumId:parent?.forumId || null,forumName:parent?.forumName || '',guildName,
        originalTitle:this.title(sidebar || main) || captured?.originalTitle || known?.originalTitle || '',url:canonical(route.guildId,threadId)};
    }
    if (!explicitNotForum && (root || knownForum)) return {
      ...route,type:'forum',forumId:route.channelId,
      forumName:this.title(main) || knownForum?.forumName || route.channelId,guildName,
      forumEvidence:!!root,forumRegistered:!!registeredForum,forumSource:registry?.source||null
    };
    return {...route,type:'unknown',guildName};
  }
  schedule() { if(this.timer)return;this.timer = setTimeout(()=>{this.timer=null;this.scan();},180); }
  scan() {
    const href = this.href();
    if (href !== this.lastHref) { this.followSerial++; clearTimeout(this.followTimer); this.pending = null; this.lastHref = href; this.menuTarget=null; this.seenExisting.clear(); }
    const c = this.inspect();
    if (c.type === 'forum') this.catalog.set(`${c.guildId}:${c.forumId}`,c);
    this.context = c;
    const sig = JSON.stringify(c);
    if (sig !== this.signature) { this.signature = sig; this.onContext(c); }
    // Opening a post with an already-confirmed Following/Leave control can recover that visible bookmark.
    const profile=this.isEnabled();
    if(profile && c.type==='thread' && this.controls().some(b=>b.isConnected!==false&&!b.closest('[role="menu"]')&&UNFOLLOW.test(controlLabel(b)))) {
      const key=profile+':'+identity(c);
      if(!this.seenExisting.has(key)){this.seenExisting.add(key);this.onFollow(c);}
    }
  }
  handleClick(event) {
    if (!event.isTrusted || event.composedPath().some(n=>n?.id==='dfa-root')) return;
    const target=event.target instanceof Element?event.target:event.target?.parentElement;
    if(!target)return;
    const anchor=target.closest('a[href]');
    const c=this.context;
    if(anchor && c.type==='forum') {
      const found=this.postFromNode(anchor,c);
      if(found){
        const {card,...record}=found;
        this.links.set(identity(record),record);
        if(this.links.size>500)this.links.delete(this.links.keys().next().value);
      }
    }
    const button=target.closest('button,[role="button"],[role="menuitem"],[role="menuitemcheckbox"]');
    if(!button||!this.isEnabled()||!FOLLOW.test(controlLabel(button)))return;
    const inMenu=!!button.closest('[role="menu"]');
    let info=this.inspect(),card=null;
    if(inMenu&&this.menuTarget&&Date.now()-this.menuTarget.at<12000){
      info=this.menuTarget.info;card=info.card;
    }else if(info.type!=='thread'){
      const found=this.postFromNode(button);
      if(found){info=found;card=found.card;}
    }
    if(inMenu&&!card&&info.type!=='thread'){this.log('follow-target-unknown');return;}
    if(info.type!=='thread'&&!info.threadId){this.log('follow-thread-unrecognized');return;}
    if(!inMenu&&!card&&!this.controls().includes(button)){this.log('follow-control-out-of-scope');return;}
    const {card:unused,...record}=info;
    const serial=++this.followSerial,href=this.href(),profile=this.isEnabled(),started=performance.now();
    clearTimeout(this.followTimer);this.pending={serial};
    const valid=()=>{
      if(serial!==this.followSerial||href!==this.href()||profile!==this.isEnabled())return false;
      if(card)return !!card.isConnected;
      const current=this.inspect();
      return current.type==='thread'&&identity(current)===identity(record);
    };
    const positive=()=>card?this.stateIn(card):this.controls().some(b=>b.isConnected!==false&&!b.closest('[role="menu"]')&&UNFOLLOW.test(controlLabel(b)));
    const check=()=>{
      if(!valid())return;
      if(positive()){
        // Re-check after stability delay; the original button may have been replaced by React.
        this.followTimer=setTimeout(()=>{
          if(!valid()||!positive())return;
          this.pending=null;this.followSerial++;this.onFollow(record);
        },650);
        return;
      }
      if(performance.now()-started<8000)this.followTimer=setTimeout(check,220);
      else{this.pending=null;this.log('native-follow-unconfirmed');}
    };
    this.followTimer=setTimeout(check,220);
  }
  start() {
    this.doc.addEventListener('click',this.click,true);
    this.doc.addEventListener('contextmenu',this.contextMenu,true);
    window.addEventListener('popstate',this.scheduled); window.addEventListener('hashchange',this.scheduled);
    this.observer = new MutationObserver(mutations=> {
      if (mutations.some(m=>m.target !== this.doc.getElementById('dfa-root') && !this.doc.getElementById('dfa-root')?.contains(m.target))) this.schedule();
    });
    this.observer.observe(this.doc.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','aria-pressed','data-thread-id']});
    // URL polling catches pushState/replaceState without patching Discord's History API.
    this.interval = setInterval(()=> { if (this.href() !== this.lastHref) this.scan(); },500);
    this.scan();
  }
  stop() {
    this.observer?.disconnect(); clearInterval(this.interval); clearTimeout(this.timer); clearTimeout(this.followTimer); this.followSerial++;
    this.doc.removeEventListener('click',this.click,true); this.doc.removeEventListener('contextmenu',this.contextMenu,true); window.removeEventListener('popstate',this.scheduled); window.removeEventListener('hashchange',this.scheduled);
  }
}


// ---- style.js ----
const STYLE = `
:host{all:initial;color-scheme:dark;--bg:#242429;--card:#2e2e35;--fg:#f2f3f5;--muted:#bbbcc7;--line:#555560;--accent:#5865f2;--hover:#3b3b43;--on-accent:#fff;font-family:gg sans,Noto Sans,Helvetica Neue,Arial,sans-serif;font-size:var(--ui-size,13px);color:var(--fg);line-height:1.5}
*{box-sizing:border-box} [hidden]{display:none!important} button,input,select{font:inherit} button,a,input,select,summary{outline-offset:3px} :focus-visible{outline:2px solid var(--accent)}
button,select{border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);padding:6px 9px;cursor:pointer;min-height:30px} button:hover,summary:hover{background:var(--hover)} button:disabled{opacity:.5;cursor:wait} button.primary{background:var(--accent);color:var(--on-accent);border-color:transparent} button.danger{border-color:#d86b78;color:var(--fg)} a{color:var(--fg);text-decoration:none} input{min-width:0;width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px} input[type=checkbox]{width:auto;accent-color:var(--accent)} input[type=range]{padding:0} input[type=file]{font-size:12px} p{margin:8px 0} small,.muted{color:var(--muted);font-size:.9em} h2{font-size:1.2em;margin:0} h3{font-size:1em;margin:15px 0 7px} .row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.grow{flex:1;min-width:0}.stack{display:grid;gap:9px}.notice{padding:9px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.status{color:var(--muted)}
.panel{position:fixed;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:13px;box-shadow:0 12px 42px #0005;overflow:hidden;min-width:0;transition:box-shadow .12s}.panel.moving{box-shadow:0 16px 50px #0009;user-select:none}.header{display:flex;align-items:center;gap:5px;padding:11px 12px 8px;cursor:grab;touch-action:none;flex-shrink:0}.header strong{letter-spacing:.2px;flex:1;min-width:0}.icon{padding:3px 7px;min-width:30px;flex-shrink:0}.context{padding:0 13px 9px;overflow-wrap:anywhere;color:var(--muted);font-size:.9em}.tools{padding:0 12px 10px;display:grid;gap:7px;flex-shrink:0}.tools select{min-width:0;flex:1;width:30%}.profile{border:0;text-align:left;padding:0;background:none;color:var(--muted);font-size:.9em;min-height:25px}.list{overflow-y:auto;overflow-anchor:none;overscroll-behavior:contain;flex:1;min-height:0;padding:2px 10px 10px;scrollbar-width:thin}.card{border:1px solid var(--line);border-radius:9px;padding:var(--spacing,10px);background:var(--card);margin:0 0 8px;content-visibility:auto;contain-intrinsic-size:auto 140px}.card-title{font-size:var(--title-size,15px);font-weight:600;line-height:1.45;overflow-wrap:anywhere;word-break:normal;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--title-lines,4);overflow:hidden}.card-title.full{display:block;overflow:visible;-webkit-line-clamp:unset}.card-title:hover{text-decoration:underline}.meta{font-size:.85em;color:var(--muted);overflow-wrap:anywhere;margin:6px 0}.actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.actions button{font-size:.85em;min-height:27px;padding:2px 7px}.star[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}.empty{padding:28px 10px;text-align:center;color:var(--muted)}.footer{padding:7px 12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.85em;color:var(--muted)}.footer button{font-size:inherit;padding:1px 6px;min-height:24px}.tab{position:fixed;width:40px;height:92px;padding:7px 4px;white-space:nowrap;writing-mode:vertical-rl;text-orientation:upright;letter-spacing:1px;border-radius:9px;box-shadow:0 4px 20px #0004;background:var(--bg);color:var(--fg)}.quick{position:fixed;right:16px;top:12px;max-width:min(300px,90vw);box-shadow:0 3px 15px #0005;background:var(--bg)}
.handle{position:absolute;touch-action:none;z-index:2}.handle[data-edge=n],.handle[data-edge=s]{height:6px;left:12px;right:12px;cursor:ns-resize}.handle[data-edge=n]{top:0}.handle[data-edge=s]{bottom:0}.handle[data-edge=e],.handle[data-edge=w]{width:6px;top:12px;bottom:12px;cursor:ew-resize}.handle[data-edge=e]{right:0}.handle[data-edge=w]{left:0}.handle[data-edge=ne],.handle[data-edge=nw],.handle[data-edge=se],.handle[data-edge=sw]{width:12px;height:12px}.handle[data-edge=ne]{right:0;top:0;cursor:nesw-resize}.handle[data-edge=nw]{left:0;top:0;cursor:nwse-resize}.handle[data-edge=se]{right:0;bottom:0;cursor:nwse-resize;background:linear-gradient(135deg,transparent 65%,var(--line) 66%,var(--line) 75%,transparent 76%)}.handle[data-edge=sw]{left:0;bottom:0;cursor:nesw-resize}
.overlay{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}.dialog{width:520px;max-width:100%;max-height:92vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:13px;padding:18px;box-shadow:0 20px 80px #0008}.dialog label{display:grid;gap:4px}.dialog label.check{display:flex;align-items:start;gap:8px}.dialog label.check input{margin-top:5px}.dialog .error{color:var(--fg);border-left:3px solid #ef6376;padding-left:8px;white-space:pre-wrap;overflow-wrap:anywhere}.dialog .row.end{justify-content:flex-end;margin-top:14px}.dialog header{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);max-width:min(600px,95vw);background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:11px 16px;box-shadow:0 7px 25px #0006;white-space:pre-wrap;overflow-wrap:anywhere}.toast.error{border-color:#ef6376}.pager{width:100%}details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer;padding:5px;border-radius:5px}

/* V1.1 compact Chinese-first forum bookmarks */
.header{padding:8px 12px 8px;gap:4px}.header strong{font-size:14px;font-weight:600;letter-spacing:0}
.context{display:block;width:calc(100% - 24px);margin:0 12px 8px;padding:4px 0;min-height:28px;
  background:transparent;border:0;text-align:left;font-size:var(--ui-size,13px);color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.context:hover{color:var(--fg);background:var(--hover)}
.tools{padding:0 12px 12px;gap:8px}
.tools input[type=search]{padding:8px 12px;height:36px}
.filters{display:grid;grid-template-columns:minmax(88px,.85fr) minmax(90px,1.4fr) 36px;gap:8px;align-items:center;min-width:0}
.scope-toggle{display:flex;align-items:center;justify-content:center;border-radius:16px;
 min-width:0;width:100%;font-size:11px;padding:4px 5px;min-height:30px;background:var(--card);white-space:nowrap}
.scope-toggle::before{content:'';width:7px;height:7px;flex:none;background:var(--muted);border-radius:99px;margin-right:5px}
.scope-toggle[aria-checked=true]{background:var(--accent);color:var(--on-accent)}
.scope-toggle[aria-checked=true]::before{background:var(--on-accent)}
.collection-select{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0;padding:6px 8px;font-size:12px;border-radius:8px}
.sort-slot{position:relative;display:flex;align-items:center;justify-content:center;width:34px;height:30px;
 background:var(--card);border:1px solid var(--line);border-radius:7px;overflow:hidden;font-size:20px}
.sort-slot select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;min-height:0}
.page-save{display:block;width:100%;min-height:36px;padding:8px 12px;font-weight:600;border:1px solid var(--accent);border-radius:8px;background:color-mix(in srgb,var(--accent) 12%,var(--card));color:var(--fg)}.page-save:hover{background:color-mix(in srgb,var(--accent) 20%,var(--card))}
.list{padding:0 12px 12px}
/* Compact reading hierarchy:
   Primary = long post title; secondary = action affordances;
   tertiary = title observation time. Use Discord palette tokens and
   4/8/12/16px spacing scale; no new fixed brand colors. */
.compact-card{
  display:grid;
  grid-template-columns:32px minmax(0,1fr) 32px;
  column-gap:8px;
  align-items:start;
  margin:0 0 8px;
  padding:var(--spacing,10px) 8px;
  border:1px solid color-mix(in srgb,var(--line) 50%,transparent);
  border-radius:10px;
  background:var(--card);
  content-visibility:auto;
  contain-intrinsic-size:auto 72px;
  transition:border-color .16s ease,background-color .16s ease;
}
.compact-card:hover{border-color:var(--line);background:color-mix(in srgb,var(--hover) 24%,var(--card))}
.compact-card .card-title{
  display:-webkit-box;
  min-width:0;
  padding-top:3px;
  font-size:var(--title-size,15px);
  font-weight:500;
  line-height:1.5;
  overflow-wrap:anywhere;
  word-break:normal;
  color:var(--fg);
}
.compact-card .card-title:hover{color:var(--fg);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.compact-card .card-title.full{display:block}
.card-side{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
.compact-card .card-side button{
  display:flex;
  align-items:center;
  justify-content:center;
  width:28px;height:28px;min-height:28px;
  padding:0;
  border:1px solid transparent;
  border-radius:8px;
  background:transparent;
  color:var(--muted);
  font-weight:500;
  cursor:pointer;
  transition:background-color .14s,color .14s,border-color .14s;
}
.compact-card .card-side button:hover{
  background:var(--hover);
  color:var(--fg);
}
.compact-card .star{font-size:19px;line-height:1}
.compact-card .star[aria-pressed=true]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.compact-card .post-age{
  max-width:32px;
  font-size:10px;
  font-weight:400;
  line-height:1.25;
  color:var(--muted);
  text-align:center;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:clip;
  cursor:help;
}
.compact-card .more{font-size:21px;line-height:1}
.compact-card .reload-title{font-size:20px;line-height:1}
.compact-card .reload-title:active{transform:rotate(-25deg)}
.footer{padding:8px 12px;align-items:center;flex-wrap:nowrap}
.footer button{white-space:nowrap;font-size:11px}
.folder-row{display:grid;grid-template-columns:minmax(0,1fr) 36px 36px;gap:5px;align-items:center}
.folder-row>button:first-child{text-align:left;min-width:0;overflow:hidden;text-overflow:ellipsis}
input[type=range]{accent-color:var(--accent)}
.slider-setting{display:grid;gap:4px;padding:4px 0}
.slider-setting>span{display:flex;justify-content:space-between;color:var(--muted)}
.slider-setting output{font-variant-numeric:tabular-nums;color:var(--fg)}


.scope-toggle{position:relative;padding-left:30px;justify-content:flex-start}
.scope-toggle::before{position:absolute;left:5px;top:8px;width:22px;height:13px;border-radius:20px;background:#777c89;margin:0;transition:background .16s}
.scope-toggle::after{content:'';position:absolute;left:7px;top:10px;width:9px;height:9px;border-radius:50%;background:white;transition:transform .16s}
.scope-toggle[aria-checked=true]{background:var(--card);color:var(--fg)}
.scope-toggle[aria-checked=true]::before{background:#50b779}
.scope-toggle[aria-checked=true]::after{transform:translateX(9px)}


/* V1.2 design tokens: retain Discord-derived colors, distinguish structure before effects. */
:host{
  --glass-border:color-mix(in srgb,var(--line) 56%,transparent);
  --glass-glint:color-mix(in srgb,var(--fg) 13%,transparent);
  --glass-shadow:0 18px 55px #0005, inset 0 1px 0 var(--glass-glint);
  --ease-glass:cubic-bezier(.22,1,.36,1);
}
.filters{
  grid-template-columns:minmax(68px,.96fr) minmax(68px,1fr) minmax(70px,1.28fr) 32px;
  gap:6px;
}
.filters .scope-toggle,.filters .update-toggle{
  min-width:0;min-height:32px;overflow:hidden;
  padding:5px 5px 5px 27px;white-space:nowrap;
  border:1px solid var(--glass-border);border-radius:18px;
  font-size:11px;font-weight:500;line-height:20px;
}
.filters .update-toggle{
  position:relative;display:flex;align-items:center;justify-content:flex-start;
  color:var(--muted);background:var(--card);
}
.filters .update-toggle[aria-checked="true"]{color:var(--fg)}
.filters .update-toggle::before,.filters .scope-toggle::before{
  content:'';position:absolute;left:5px;top:9px;width:21px;height:12px;
  margin:0;border-radius:99px;background:var(--muted);opacity:.7;
  transition:background-color .2s var(--ease-glass);
}
.filters .update-toggle::after,.filters .scope-toggle::after{
  content:'';position:absolute;left:7px;top:11px;width:8px;height:8px;
  border-radius:99px;background:var(--fg);
  transition:transform .2s var(--ease-glass);
}
.filters .update-toggle[aria-checked="true"]::before{background:var(--accent);opacity:1}
.filters .update-toggle[aria-checked="true"]::after{transform:translateX(9px);background:var(--on-accent)}
.filters .scope-toggle[aria-checked="true"]::before{background:var(--accent);opacity:1}
.filters .scope-toggle[aria-checked="true"]::after{background:var(--on-accent)}
.filters .collection-select{height:32px;font-size:11px;padding:5px 6px}
.filters .sort-slot{width:32px;height:32px;border-radius:9px}
.title-changed{border-left:2px solid var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--card))}
.title-changed .card-title::before{content:'•';display:inline;color:var(--accent);padding-right:5px;font-size:15px}
.settings-dialog{
  display:flex;flex-direction:column;overflow:hidden;
  width:min(760px,calc(100vw - 24px));max-height:min(86dvh,800px);
  padding:0;border-radius:16px;
}
.settings-dialog>header{
  flex:none;padding:18px 22px 12px;margin:0;
  border-bottom:1px solid var(--glass-border);
}
.settings-dialog>header h2{font-size:16px;font-weight:600}
.settings-body{display:flex!important;flex:1;min-height:0;flex-direction:column;gap:0}
.settings-tabs{
  flex:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
  gap:4px;padding:10px 16px;background:color-mix(in srgb,var(--card) 46%,transparent);
  border-bottom:1px solid var(--glass-border);
}
.settings-tabs button{
  border:1px solid transparent;background:transparent;border-radius:9px;
  font-size:13px;font-weight:500;min-height:38px;
}
.settings-tabs button[aria-selected="true"]{
  color:var(--fg);background:var(--card);border-color:var(--glass-border);
  box-shadow:0 2px 7px #0001;
}
.settings-panes{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.settings-pane{display:grid;align-content:start;gap:16px;padding:18px 22px 22px}
.settings-group{
  display:grid;gap:12px;min-width:0;
  background:color-mix(in srgb,var(--card) 64%,transparent);
  border:1px solid var(--glass-border);border-radius:12px;padding:16px;
}
.settings-group h3{margin:0 0 2px;font-size:13px;font-weight:600}
.settings-group p{margin:0;line-height:1.7}
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.settings-field{display:grid;gap:6px;min-width:0;font-size:12px;color:var(--muted);font-weight:500}
.settings-field input,.settings-field select{
  min-width:0;width:100%;height:38px;padding:7px 10px;
  border-radius:9px;color:var(--fg);font-size:13px;
}
.settings-check{
  display:flex!important;align-items:center;gap:10px;
  min-height:34px;font-size:13px;line-height:1.45;
}
.settings-check input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--accent)}
.settings-slider{display:grid;gap:8px;font-size:13px}
.settings-slider>span{display:flex;justify-content:space-between;align-items:center;color:var(--muted)}
.settings-slider output{font-variant-numeric:tabular-nums;color:var(--fg)}
.settings-slider input{width:100%;accent-color:var(--accent)}
.settings-actions{
  display:flex;flex:none;align-items:center;justify-content:flex-end;gap:10px;
  padding:12px 22px;border-top:1px solid var(--glass-border);
  background:color-mix(in srgb,var(--bg) 94%,var(--card));
}
.settings-actions button{min-width:94px;min-height:38px}
.settings-save{font-weight:600}
:host([data-glass="on"]) .panel,
:host([data-glass="on"]) .dialog,
:host([data-glass="on"]) .tab{
  background:linear-gradient(156deg,color-mix(in srgb,var(--fg) 7%,transparent),transparent 34%),
             color-mix(in srgb,var(--bg) 90%,transparent);
  border:1px solid var(--glass-border);
  box-shadow:var(--glass-shadow);
}
@supports (backdrop-filter:blur(1px)){
  :host([data-glass="on"]) .panel,
  :host([data-glass="on"]) .dialog,
  :host([data-glass="on"]) .tab{
    backdrop-filter:blur(20px) saturate(1.22);
    -webkit-backdrop-filter:blur(20px) saturate(1.22);
  }
}
:host([data-glass="on"]) .compact-card{
  background:linear-gradient(145deg,color-mix(in srgb,var(--fg) 3%,transparent),transparent 66%),var(--card);
  border-color:var(--glass-border);
}
:host([data-glass="on"]) .compact-card:hover{
  border-color:color-mix(in srgb,var(--accent) 30%,var(--line));
  box-shadow:inset 0 1px 0 var(--glass-glint),0 4px 16px #0002;
}
:host([data-motion="on"]) .compact-card,
:host([data-motion="on"]) .icon,
:host([data-motion="on"]) .page-save,
:host([data-motion="on"]) .settings-tabs button,
:host([data-motion="on"]) .update-toggle{
  transition:border-color 180ms var(--ease-glass),background-color 180ms var(--ease-glass),
    box-shadow 200ms var(--ease-glass),transform 180ms var(--ease-glass);
}
:host([data-motion="on"]) .icon:hover,
:host([data-motion="on"]) .page-save:hover{transform:translateY(-1px)}
:host([data-motion="on"]) .icon:active,
:host([data-motion="on"]) .page-save:active{transform:translateY(0) scale(.98)}
@media(max-width:550px){
  .settings-dialog{width:calc(100vw - 16px);max-height:92dvh}
  .settings-dialog>header{padding:12px 16px}
  .settings-pane{padding:12px}
  .settings-group{padding:12px;gap:10px}
  .settings-grid{grid-template-columns:minmax(0,1fr)}
  .settings-tabs{padding:8px}
  .settings-actions{padding:10px 12px}
}
:host([data-motion="off"]) *, :host([data-motion="off"]) *::before,:host([data-motion="off"]) *::after{animation:none!important;transition:none!important}

/* Three-state iOS-inspired segmented picker: scope is the entire current server. */
.filters{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px}
.filter-segments{grid-column:1/-1}
.filters .collection-select{grid-column:1;min-width:0}
.filters .sort-slot{grid-column:2}
.filter-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;min-width:0;
 padding:3px;border:1px solid var(--glass-border);border-radius:12px;
 background:color-mix(in srgb,var(--card) 88%,var(--bg))}
.filter-segments .filter-segment{
 display:flex;align-items:center;justify-content:center;min-width:0;min-height:27px;
 padding:4px 3px;border:1px solid transparent;border-radius:9px;
 background:transparent;color:var(--muted);font-size:11px;font-weight:500;white-space:nowrap;
 transition:background-color 180ms ease,color 180ms ease,box-shadow 180ms ease}
.filter-segments .filter-segment[aria-pressed="true"]{
 color:var(--fg);font-weight:600;background:color-mix(in srgb,var(--accent) 13%,var(--card));
 border-color:color-mix(in srgb,var(--accent) 30%,var(--line));
 box-shadow:0 2px 8px #0002,inset 0 1px 0 color-mix(in srgb,var(--fg) 12%,transparent)}
.filter-segments .filter-segment:not([aria-pressed="true"]):hover{background:var(--hover);color:var(--fg)}
.filter-segments .filter-segment:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media(max-width:390px){
 .filter-segments .filter-segment{font-size:10px;padding:3px 1px}
}

@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}*::before,*::after{transition:none!important;animation:none!important}}`;


// ---- app.js ----
// Browser application. All user content is rendered with textContent; no HTML injection.
function element(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key === 'text') e.textContent = value;
    else if (key === 'class') e.className = value;
    else if (key.startsWith('on')) e.addEventListener(key.slice(2).toLowerCase(),value);
    else if (key === 'value' || key === 'checked' || key === 'disabled') e[key] = value;
    else if (value !== null && value !== undefined) e.setAttribute(key,String(value));
  }
  e.append(...children.filter(c=>c !== null && c !== undefined)); return e;
}
// Discord listens for keyboard shortcuts above the userscript's Shadow DOM.
// Consume bubbling UI events at the ShadowRoot boundary after native controls
// have received them, without cancelling their default typing/IME behaviour.
function isolatePanelEvents(root, host = root.host) {
  const types = [
    'keydown','keypress','keyup','beforeinput','input',
    'compositionstart','compositionupdate','compositionend',
    'paste','cut','copy','focusin','focusout',
    'pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu'
  ];
  const stop = event => event.stopPropagation();
  // Outside a Shadow DOM, Discord sees the shadow host as the keyboard target,
  // not the real input. Temporarily exposing the host as editable also prevents
  // capture-phase shortcuts that use target.isContentEditable as a guard.
  const editSelector = 'input:not([type="checkbox"]):not([type="range"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]';
  const priorEditable=host?.getAttribute?.('contenteditable');
  const priorTabindex=host?.getAttribute?.('tabindex');
  const mark = target => {
    if(!host?.setAttribute)return;
    if(target?.matches?.(editSelector)){
      host.setAttribute('contenteditable','true');
      host.setAttribute('tabindex','-1');
    }else {
      host.removeAttribute('contenteditable');
      if(priorTabindex===null)host.removeAttribute('tabindex');
      else host.setAttribute('tabindex',priorTabindex);
    }
  };
  const entering = event => mark(event.target);
  const leaving = () => queueMicrotask(()=>mark(root.activeElement));
  for (const type of types) root.addEventListener(type,stop);
  root.addEventListener('focusin',entering);
  root.addEventListener('focusout',leaving);
  return () => {
    for(const type of types)root.removeEventListener(type,stop);
    root.removeEventListener('focusin',entering);
    root.removeEventListener('focusout',leaving);
    if(host?.setAttribute){
      if(priorEditable===null)host.removeAttribute('contenteditable');else host.setAttribute('contenteditable',priorEditable);
      if(priorTabindex===null)host.removeAttribute('tabindex');else host.setAttribute('tabindex',priorTabindex);
    }
  };
}
class ArchiveApp {
  constructor(storage, href = ()=>location.href) {
    this.storage = storage; this.prefs = cleanPrefs(); this.context = {type:'unknown'}; this.profile = null; this.store = null;
    this.query = ''; this.limit = 80; this.expanded = new Set(); this.scroll = new Map(); this.bookmarkNavigationScroll = null; this.force = false; this.destroyed = false;
    this.href=href;this.cleanups = []; this.lastRouteKey = ''; this.modalClose = null; this.prefQueue = Promise.resolve(); this.revision = 0;
    this.log = event=> { if (this.prefs.debug) console.debug('[Forum Archive]',event); };
    this.safe = fn=> (...args)=> Promise.resolve().then(()=>fn(...args)).catch(e=>this.report(e));
  }
  async start() {
    if (document.getElementById('dfa-root')) return;
    this.host = element('div',{id:'dfa-root'}); this.host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
    this.root = this.host.attachShadow({mode:'open'}); this.cleanups.push(isolatePanelEvents(this.root));
    const style = element('style',{text:STYLE+' .panel,.tab,.overlay,.toast,.quick{pointer-events:auto}'});
    this.root.append(style); document.body.append(this.host);
    this.buildPanel(); this.applyTheme();
    this.adapter = new DiscordAdapter(document,c=>this.safe(()=>this.navigate(c))(),c=>this.safe(()=>this.capture(c))(),()=>this.profile && this.prefs.autoFollow ? this.profile.id : null,this.log,this.href);
    this.adapter.start();
    const resize = ()=>this.layout(); window.addEventListener('resize',resize); this.cleanups.push(()=>window.removeEventListener('resize',resize));
    const focus = ()=>this.safe(()=>this.sync())(); window.addEventListener('focus',focus); document.addEventListener('visibilitychange',focus);
    this.cleanups.push(()=> {window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);});
    this.syncTimer = setInterval(()=> { if (!document.hidden) focus(); },5000);
    this.themeObserver = new MutationObserver(()=>this.applyTheme());
    this.themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
    this.themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style','data-theme']});
    this.themeTimer = setInterval(()=>this.applyTheme(),2500);
    if (this.storage.listen) this.listener = await this.storage.listen(`${PREFIX}pulse`,focus);
    const menu = (name,fn)=>this.storage.menu?.(name,this.safe(fn));
    menu('显示 Forum Archive',()=>this.setMode('expanded',true));
    menu('Forum Archive 设置',()=>this.settings());
    menu('切换本地资料库 / 账号',()=>this.chooseProfile());
    menu('导入当前可见的已关注帖',()=>this.importVisibleFollowed());
    menu('通过链接添加帖子',()=>this.addDialog());
    menu('导出 JSON 备份',()=>this.exportNow());
    menu('导入 JSON 备份',()=>this.dataDialog());
    menu('重置面板位置',()=>this.resetLayout());
    this.layout(); this.renderList();
    const preferred=await this.storage.get(`${PREFIX}activeProfile`,null);
    const available=await this.profiles();
    const chosen=available.find(p=>p.id===preferred) || (available.length===1?available[0]:null);
    if(chosen)await this.activate(chosen);
    else await this.chooseProfile();
    const teardown = e=> { if(!e.persisted)this.stop(); }; window.addEventListener('pagehide',teardown);
    this.cleanups.push(()=>window.removeEventListener('pagehide',teardown));
  }
  async savePrefs(patch) {
    if (!this.profile) return;
    const id = this.profile.id;
    // Serialize writes within one tab. Layout preferences intentionally use last-writer-wins across tabs.
    this.prefQueue = this.prefQueue.catch(()=>{}).then(async()=> {
      const key = `${PREFIX}prefs:${id}`;
      const current = cleanPrefs(await this.storage.get(key,{})); const next = cleanPrefs({...current,...patch});
      await this.storage.set(key,next);
      if (JSON.stringify(await this.storage.get(key,{})) !== JSON.stringify(next)) throw new Error('设置保存校验失败。');
      if (id === this.profile?.id) { this.prefs = next; if(Object.hasOwn(patch,'knownForums'))this.adapter?.setKnownForums(next.knownForums); this.layout(); this.applyTheme(); }
    });
    return this.prefQueue;
  }
  async sync() {
    if (!this.store || this.syncBusy) return;
    this.syncBusy = true;
    try { await this.store.refresh(); } finally { this.syncBusy = false; }
  }
  report(error) {
    this.log('operation-failed');
    this.toast(error instanceof Error ? error.message : '操作失败；请检查存储权限。',true);
  }
  toast(message,error = false) {
    this.toastEl?.remove(); clearTimeout(this.toastTimer);
    this.toastEl = element('div',{class:`toast${error?' error':''}`,role:error?'alert':'status',text:message}); this.root.append(this.toastEl);
    this.toastTimer = setTimeout(()=>this.toastEl?.remove(),error?12000:5500);
  }
  dialog(title, build) {
    this.modalClose?.(); const previous = this.root.activeElement || document.activeElement;
    const overlay = element('div',{class:'overlay'}), box = element('section',{class:'dialog',role:'dialog','aria-modal':'true','aria-label':title,tabindex:'-1'});
    const close = ()=> { overlay.remove(); if (this.modalClose === close) this.modalClose = null; previous?.focus?.(); };
    this.modalClose = close;
    box.append(element('header',{},element('h2',{text:title}),element('button',{'aria-label':'关闭弹窗',text:'×',onclick:close})));
    overlay.append(box); overlay.addEventListener('click',e=> {if(e.target===overlay) close();});
    box.addEventListener('keydown',e=> {
      if (e.key === 'Escape') { e.preventDefault();e.stopPropagation();close(); }
      if (e.key === 'Tab') {
        const focusable = [...box.querySelectorAll('button,input,select,a[href],summary,[tabindex="0"]')].filter(e=>!e.disabled && !e.hidden && e.getClientRects().length);
        if (!focusable.length) {e.preventDefault();box.focus();return;}
        if (e.shiftKey && (this.root.activeElement === focusable[0] || this.root.activeElement === box)) {e.preventDefault();focusable.at(-1).focus();}
        else if (!e.shiftKey && (this.root.activeElement === focusable.at(-1) || !box.contains(this.root.activeElement))) {e.preventDefault();focusable[0].focus();}
      }
    });
    const content = element('div',{class:'stack'}), err = element('p',{class:'error',role:'alert',hidden:true}); box.append(content,err);
    const submit = fn=>this.safe(async()=> {
      err.hidden = true; const buttons = [...box.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
      try { await fn(); } catch(e) {err.textContent=e.message;err.hidden=false;}
      finally { buttons.forEach(b=>b.disabled=false); }
    });
    this.root.append(overlay); build(content,close,submit,box);
    queueMicrotask(()=> { ([...box.querySelectorAll('input,select,button')].find(e=>!e.closest('[hidden]')&&!e.disabled) || box).focus(); });
    return {box,content,close};
  }
  async profiles() {
    const keys = (await this.storage.list()).filter(k=>k.startsWith(`${PREFIX}profile:`)); const result=[];
    for(const key of keys) {
      const p=await this.storage.get(key,null);
      if(p && typeof p.id==='string' && /^[\w-]{8,100}$/.test(p.id) && typeof p.name==='string' && p.name.length<=100 && key===`${PREFIX}profile:${p.id}`) result.push(p);
    } return result;
  }
  async chooseProfile() {
    const profiles = await this.profiles();
    this.dialog('选择本地资料库', (body,close,submit)=> {
      if (profiles.length) {
        const select=element('select',{'aria-label':'已有资料库'},...profiles.map(p=>element('option',{value:p.id,text:p.name})));
        body.append(select,element('button',{class:'primary',text:'使用所选资料库',onclick:submit(async()=>{await this.activate(profiles.find(p=>p.id===select.value));close();})}));
      }
      const name=element('input',{placeholder:'例如：学校账号 / 个人账号',maxlength:'100','aria-label':'新资料库名称'});
      body.append(element('h3',{text:'创建新资料库'}),name,element('button',{text:'创建并使用',onclick:submit(async()=>{
        if(!name.value.trim()) throw new Error('请填写资料库名称。');
        const p={id:uid(),name:name.value.trim(),createdAt:Date.now()}; const key=`${PREFIX}profile:${p.id}`;
        await this.storage.set(key,p);if((await this.storage.get(key,null))?.id!==p.id)throw new Error('资料库创建失败。');
        await this.activate(p);close();
      })}));
    });
  }
  async activate(profile) {
    await this.prefQueue.catch(()=>{});
    const savedPrefs=await this.storage.get(`${PREFIX}prefs:${profile.id}`,null);
    const nextPrefs=cleanPrefs(savedPrefs || {...cleanPrefs(),height:Math.round(innerHeight*.7)});
    const nextStore=new ArchiveStore(this.storage,profile.id,()=> {if(this.store===nextStore)this.changed();});
    await nextStore.refresh(); // Keep the previous library intact if loading fails.
    await this.storage.set(`${PREFIX}activeProfile`,profile.id);
    this.profile=profile;this.prefs=nextPrefs;this.store=nextStore;this.revision++;this.query='';this.search.value='';this.expanded.clear();this.scroll.clear();this.bookmarkNavigationScroll=null;
    const resume=this.takeBookmarkScroll(profile.id);
    if(resume){
      this.scroll.set(resume.guildId,resume.top);
      this.bookmarkNavigationScroll={guildId:resume.guildId,top:resume.top,until:Date.now()+5000};
      this.query=resume.query;this.search.value=resume.query;this.limit=resume.limit;
    }
    this.adapter.setKnownForums(this.prefs.knownForums);
    this.force=false;this.changed();this.layout();this.applyTheme();
    if(resume&&this.context.guildId===resume.guildId)this.list.scrollTop=resume.top;
    this.adapter.scan();
  }
  changed() {
    this.adapter.seed(this.store?.records.values() || []);this.adapter.schedule();this.renderList();this.updateContext();
    if (this.store?.invalidCount) this.toast(`检测到 ${this.store.invalidCount} 条无法读取的变更，已保留原数据。请导出可读取记录并保留 Tampermonkey 备份。`,true);
  }
  // Short-lived, same-tab checkpoint. Discord may use either SPA routing
  // or a real page load for links inside the userscript's Shadow DOM.
  takeBookmarkScroll(profileId) {
    let raw=null;
    try {
      const key=PREFIX+'scroll:'+profileId;
      raw=JSON.parse(sessionStorage.getItem(key)||'null');
      sessionStorage.removeItem(key);
    }catch{return null;}
    if(!raw||!ID.test(raw.guildId||'')||!Number.isFinite(raw.top)||
      raw.top<0||raw.top>10000000||!Number.isFinite(raw.at)||
      Date.now()-raw.at>60000||Date.now()<raw.at)return null;
    return {guildId:raw.guildId,top:raw.top,
      query:typeof raw.query==='string'?raw.query.slice(0,500):'',
      limit:Number.isSafeInteger(raw.limit)?Math.max(80,Math.min(10000,raw.limit)):80};
  }
  captureBookmarkScroll() {
    if(!this.profile||!this.context.guildId||!this.list)return;
    const top=this.list.scrollTop,guildId=this.context.guildId;
    this.scroll.set(guildId,top);
    // Preserve the click-time position if Discord updates its DOM before
    // the route observer runs. Native link navigation may reload the page.
    this.bookmarkNavigationScroll={guildId,top,until:Date.now()+5000};
    try {
      sessionStorage.setItem(PREFIX+'scroll:'+this.profile.id,
        JSON.stringify({guildId,top,query:this.query,limit:this.limit,at:Date.now()}));
    }catch{} // Disabled or full session storage must not block navigation.
  }
  async navigate(c) {
    const previousGuild=this.context.guildId, nextGuild=c.guildId;
    const pending=this.bookmarkNavigationScroll;
    if(previousGuild && this.list){
      const saved=pending?.guildId===previousGuild && Date.now()<pending.until ?
        pending.top : this.list.scrollTop;
      this.scroll.set(previousGuild,saved);
    }
    this.context=c;
    // A post and its parent forum share the same server-wide bookmark view.
    // Only a genuine server switch should reset the search and visible limit.
    if(nextGuild!==previousGuild && !(pending?.guildId===nextGuild&&Date.now()<pending.until)){
      this.query='';this.search.value='';this.limit=80;
    }
    this.updateContext();this.renderList();this.layout();
    this.list.scrollTop=nextGuild ? (this.scroll.get(nextGuild)??0) : 0;
    if(pending?.guildId===nextGuild&&this.profile){
      try{sessionStorage.removeItem(PREFIX+'scroll:'+this.profile.id);}catch{}
    }
    this.bookmarkNavigationScroll=null;
    // Preserve a positively observed forum in the active local profile.
    // Manual correction to "not a forum" always wins.
    if(c.type==='forum' && c.forumEvidence && c.guildId && c.forumId && this.profile){
      const id=c.guildId+':'+c.forumId;
      if(!this.prefs.knownForums[id]){
        await this.savePrefs({knownForums:{...this.prefs.knownForums,[id]:{source:'observed',kind:'forum'}}});
      }
    }
    if(c.type==='thread' && this.store) await this.store.observe(c);
  }
  currentFilter() {
    return {...{scope:'server',sort:this.prefs.defaultSort,updates:'all'},...(this.prefs.filters[this.context.guildId]||{}),scope:'server'};
  }
  async filterChange() {
    if(!this.profile)return this.chooseProfile();
    const filters={...this.prefs.filters,[this.context.guildId]:{scope:'server',sort:this.sort.value,updates:this.viewMode}};
    await this.savePrefs({filters});this.limit=80;this.renderList();
  }
  updateContext() {
    const c=this.context,f=this.currentFilter();
    const guildName=this.prefs.guildAliases[c.guildId]||c.guildName||(c.guildId?'服务器 '+c.guildId:'非服务器页面');
    const forumId=c.forumId || (c.type==='forum'?c.channelId:null);
    const forumName=this.prefs.forumAliases[c.guildId+':'+forumId]||c.forumName||(forumId?'频道 '+forumId:'当前频道');
    this.contextEl.textContent=c.guildId ? guildName+' · '+forumName : '私信 / 非服务器页面';
    this.profileEl.textContent=this.profile ? this.profile.name : '';
    this.viewMode=['all','changed','missing'].includes(f.updates)?f.updates:'all';
    for(const button of this.filterButtons){
      const active=button.value===this.viewMode;
      button.setAttribute('aria-pressed',String(active));
      button.setAttribute('aria-selected',String(active));
    }
    this.sort.value=f.sort; this.sort.title=this.sort.selectedOptions?.[0]?.textContent||'排序';
    this.collectionButton.textContent=this.selectedFolder().name+' ▾';
    const saved=this.store && c.type==='thread' && this.store.records.has(identity(c));
    this.quick.textContent=saved?'★ 已本地收藏 · 管理':'☆ 本地收藏此帖';
    this.pageSave.textContent=saved?'已收藏当前帖子':'☆ 收藏当前帖子';
  }
  selectedFolder() {
    const guild=this.context.guildId;
    const selected=this.prefs.folderSelections[guild] || 'default';
    return this.prefs.folders.find(f=>f.id===selected) || this.prefs.folders[0];
  }
  async selectFolder(id) {
    const guild=this.context.guildId;
    if(!guild||!this.prefs.folders.some(f=>f.id===id))return;
    await this.savePrefs({folderSelections:{...this.prefs.folderSelections,[guild]:id}});
    this.renderList();this.updateContext();
  }
  folderDialog() {
    if(!this.profile)return this.chooseProfile();
    this.dialog('收藏夹',(body,close,submit)=>{
      const draw=()=>{
        body.replaceChildren();
        for(const folder of this.prefs.folders) {
          const id=folder.id,row=element('div',{class:'folder-row'});
          row.append(element('button',{class:id===this.selectedFolder().id?'primary':'',text:folder.name,onclick:submit(async()=>{await this.selectFolder(id);close();})}));
          row.append(element('button',{'aria-label':'重命名收藏夹 '+folder.name,text:'✎',onclick:()=>this.renameFolder(id)}));
          if(id!=='default')row.append(element('button',{'aria-label':'删除收藏夹 '+folder.name,text:'×',onclick:()=>this.deleteFolder(id)}));
          body.append(row);
        }
        body.append(element('button',{class:'primary',text:'+ 新建收藏夹',onclick:()=>this.renameFolder(null)}));
      };
      draw();
    });
  }
  renameFolder(id) {
    const current=id?this.prefs.folders.find(f=>f.id===id):null;
    this.dialog(current?'重命名收藏夹':'新建收藏夹',(body,close,submit)=>{
      const name=element('input',{value:current?.name||'',maxlength:'80',placeholder:'收藏夹名称','aria-label':'收藏夹名称'});
      body.append(name,element('button',{class:'primary',text:'保存',onclick:submit(async()=>{
        const value=name.value.trim();if(!value)throw new Error('请输入名称。');
        const newId=current?null:uid();
        const folders=current?this.prefs.folders.map(f=>f.id===id?{...f,name:value}:f):
          [...this.prefs.folders,{id:newId,name:value}];
        const updates={folders};
        if(newId&&this.context.guildId)updates.folderSelections={...this.prefs.folderSelections,[this.context.guildId]:newId};
        await this.savePrefs(updates);close();this.updateContext();this.renderList();
      })}));
    });
  }
  deleteFolder(id) {
    const folder=this.prefs.folders.find(f=>f.id===id);
    if(!folder||id==='default')return;
    this.dialog('删除收藏夹',(body,close,submit)=>{
      const used=[...this.store.records.values()].filter(r=>r.collectionId===id).length;
      body.append(element('p',{text:'删除「'+folder.name+'」？其中 '+used+' 个收藏将移至默认收藏夹。'}),
        element('button',{class:'danger',text:'确认删除',onclick:submit(async()=>{
          // Move bookmarks first; only remove folder after every write completes.
          for(const record of [...this.store.records.values()].filter(r=>r.collectionId===id))
            await this.store.patch(identity(record),{collectionId:'default'});
          const selections={...this.prefs.folderSelections};
          for(const guild of Object.keys(selections))if(selections[guild]===id)selections[guild]='default';
          await this.savePrefs({folders:this.prefs.folders.filter(f=>f.id!==id),folderSelections:selections});
          close();this.updateContext();this.renderList();
        })}));
    });
  }
  editContextNames() {
    const c=this.context;if(!c.guildId)return;
    const fid=c.forumId||(c.type==='forum'?c.channelId:null),key=c.guildId+':'+fid;
    this.dialog('修改显示名称',(body,close,submit)=>{
      const guild=element('input',{value:this.prefs.guildAliases[c.guildId]||'',maxlength:'120',placeholder:c.guildName||c.guildId,'aria-label':'自定义服务器名称'});
      const forum=element('input',{value:this.prefs.forumAliases[key]||'',maxlength:'120',placeholder:c.forumName||'当前频道','aria-label':'自定义论坛名称'});
      body.append(element('label',{text:'服务器名称'},guild),element('label',{text:'论坛名称'},forum),
        element('button',{text:'频道类型识别 / 修正',onclick:()=>this.forumRecognitionDialog()}),
        element('button',{class:'primary',text:'保存',onclick:submit(async()=>{
          const ga={...this.prefs.guildAliases},fa={...this.prefs.forumAliases};
          if(guild.value.trim())ga[c.guildId]=guild.value.trim();else delete ga[c.guildId];
          if(fid){if(forum.value.trim())fa[key]=forum.value.trim();else delete fa[key];}
          await this.savePrefs({guildAliases:ga,forumAliases:fa});this.updateContext();close();
        })}));
    });
  }
  // All type choices are profile-local. They never change Discord channel metadata.
  async saveForumRecognition(guildId,channelId,kind) {
    if(!this.profile||!ID.test(guildId||'')||!ID.test(channelId||''))throw new Error('当前链接没有有效的服务器与频道 ID。');
    const key=guildId+':'+channelId,knownForums={...this.prefs.knownForums};
    if(kind===null)delete knownForums[key];
    else if(kind==='forum'||kind==='not-forum')knownForums[key]={kind,source:'manual'};
    else throw new Error('频道类型不合法。');
    await this.savePrefs({knownForums});
    this.adapter.scan();
    this.updateContext();
  }
  forumRecognitionDialog({scanAfter=false}={}) {
    const route=this.adapter.inspect();
    const guildId=route.guildId,channelId=route.channelId;
    if(!guildId||!channelId){
      this.toast('当前网址没有有效的服务器频道 ID。');return;
    }
    const key=guildId+':'+channelId;
    const registered=this.prefs.knownForums[key];
    this.dialog('确认频道类型',(body,close,submit)=>{
      body.append(
        element('p',{text:'Discord 的论坛和帖子可能使用相同格式的网址。这里仅记录当前频道类型，不修改 Discord。'}),
        element('p',{class:'muted',text:'当前频道 ID：'+channelId}),
        element('p',{class:'muted',text:registered?
          ('本地识别：'+(registered.kind==='not-forum'?'不是论坛':'论坛')+
           '（'+(registered.source==='manual'?'手动确认':'自动识别')+'）'):'本地尚未登记此频道类型。'}),
        element('button',{class:'primary',text:'✓ 确认当前频道是论坛',onclick:submit(async()=>{
          await this.saveForumRecognition(guildId,channelId,'forum');close();
          if(scanAfter)await this.refreshVisibleTitles();
          else this.toast('已记住该论坛，今后无需重复确认。');
        })}),
        element('button',{text:'这不是论坛（纠正误识别）',onclick:submit(async()=>{
          await this.saveForumRecognition(guildId,channelId,'not-forum');close();
          this.toast('已标记为非论坛；不会再被页面启发式自动覆盖。');
        })}),
        element('button',{text:'恢复自动识别',onclick:submit(async()=>{
          await this.saveForumRecognition(guildId,channelId,null);close();
          this.toast('已清除人工识别，恢复页面自动判断。');
        })})
      );
    });
  }
  sortDialog() {
    const labels=['最近收藏','最早收藏','最近修改','最早修改','标题 A → Z','标题 Z → A','星标优先'];
    this.dialog('排序方式',(body,close,submit)=>{
      for(const [i,value] of SORTS.entries())body.append(element('button',{
        text:(this.sort.value===value?'✓ ':'')+labels[i],onclick:submit(async()=>{
          this.sort.value=value;await this.filterChange();close();
        })}));
    });
  }
  cardMenu(record) {
    this.dialog('帖子操作',(body,close,submit)=>{
      body.append(element('p',{class:'muted',text:record.customTitle??record.originalTitle}));
      const actions=[
        ...(record.changeUnread?[['标记标题变化为已查看',()=>this.store.patch(identity(record),{changeUnread:false})]]:[]),
        ['编辑',()=>this.editDialog(record)],
        ['复制链接',()=>this.copy(record.url)],
        ['删除收藏',()=>this.deleteDialog(record)]
      ];
      for(const [label,action] of actions)body.append(element('button',{text:label,onclick:submit(async()=>{close();await action();})}));
    });
  }
  async reloadOneTitle(record) {
    const current=this.adapter.visiblePostInfo(identity(record));
    if(!current?.originalTitle){this.toast('请先在 Discord 打开此帖子或让它显示在当前论坛页面。');return;}
    await this.store.observe(current);
    this.toast('已检查当前可见的帖子标题。');
  }
  async refreshVisibleTitles() {
    if(!this.profile)return this.chooseProfile();
    const c=this.adapter.inspect();
    if(c.type!=='forum'||!c.guildId||!c.forumId){
      if(c.guildId&&c.channelId){
        // Even a misclassified thread route can be corrected explicitly.
        this.forumRecognitionDialog({scanAfter:true});return;
      }
      this.toast('当前不是服务器频道页面，请进入论坛后再更新。');
      return;
    }
    const scanKey=c.guildId+':'+c.forumId;
    if(Date.now()-(this.lastTitleRefresh?.[scanKey]||0)<10000){
      this.toast('此论坛刚检查过，请稍后再试。');return;
    }
    const posts=this.adapter.collectVisiblePosts().filter(p=>p.guildId===c.guildId&&p.forumId===c.forumId);
    const visibleIds=new Set(posts.map(p=>p.threadId));
    if(!visibleIds.size){
      this.toast('此论坛没有可读取的活跃帖子卡片；未标记任何帖子为未检测到。');
      return;
    }
    await this.store.refresh();
    const comparison=compareVisibleForum(this.store.records.values(),{
      guildId:c.guildId,forumId:c.forumId,visibleThreadIds:visibleIds
    });
    let changed=0;
    for(const post of posts){
      const before=this.store.records.get(identity(post));
      if(!before)continue;
      if(post.originalTitle && post.originalTitle!==before.originalTitle)changed++;
      await this.store.observe(post);
    }
    await this.savePrefs({scanResults:{...this.prefs.scanResults,[scanKey]:comparison}});
    this.lastTitleRefresh={...this.lastTitleRefresh,[scanKey]:Date.now()};
    this.renderList();
    this.toast('已检查活跃帖子 '+comparison.visibleCount+' 条；匹配收藏 '+comparison.matchedCount+
      ' 条，标题更新 '+changed+' 条；本次未检测到 '+comparison.missing.length+' 条（不代表失效）。');
  }
  buildPanel() {
    const btn=(text,label,fn,cls='icon')=>element('button',{text,'aria-label':label,title:label,class:cls,onclick:this.safe(fn)});
    this.panel=element('section',{class:'panel','aria-label':'Forum Archive 收藏管理'});
    this.header=element('header',{class:'header'},element('strong',{text:'Forum Archive'}),
      btn('+','添加帖子链接',()=>this.addDialog()),btn('⚙','设置',()=>this.settings()),btn('−','折叠面板',()=>this.setMode('collapsed')),btn('×','隐藏面板',()=>this.setMode('hidden')));
    this.contextEl=element('button',{class:'context',title:'点击编辑服务器和论坛的显示名称',onclick:this.safe(()=>this.editContextNames())});
    this.profileEl=element('div',{class:'profile'});
    this.search=element('input',{type:'search',placeholder:'搜索帖子标题','aria-label':'搜索收藏'});
    this.search.addEventListener('input',()=>{this.query=this.search.value;this.limit=80;this.renderList();});
    this.viewMode='all';
    this.filterButtons=[['all','全部'],['changed','更新'],['missing','未检测到']].map(([value,label])=>
      element('button',{class:'filter-segment',value,role:'tab','aria-label':label,'aria-pressed':'false',
        onclick:this.safe(async()=>{this.viewMode=value;await this.filterChange();})},document.createTextNode(label)));
    this.filterSegments=element('div',{class:'filter-segments',role:'tablist','aria-label':'收藏筛选'},...this.filterButtons);
    this.collectionButton=element('button',{class:'collection-select',title:'选择或管理收藏夹',onclick:this.safe(()=>this.folderDialog())});
    this.sort=element('select',{'aria-label':'排序方式'},...SORTS.map((v,i)=>element('option',{value:v,text:['收藏时间 ↓','收藏时间 ↑','修改时间 ↓','修改时间 ↑','标题 A→Z','标题 Z→A','星标优先'][i]})));
    this.sort.addEventListener('change',this.safe(()=>this.filterChange()));
    const sortSlot=element('div',{class:'sort-slot',title:'选择排序方式'},element('span',{text:'⇅'}),this.sort);
    this.pageSave=btn('☆ 收藏当前帖子','一键收藏当前帖子',()=>this.saveCurrent(),'page-save');
    this.list=element('div',{class:'list',role:'region','aria-label':'收藏列表',tabindex:'0'});
    this.count=element('span',{role:'status'});
    this.panel.append(this.header,this.contextEl,
      element('div',{class:'tools'},this.search,element('div',{class:'filters'},this.filterSegments,this.collectionButton,sortSlot),this.pageSave),
      this.list,element('footer',{class:'footer'},this.count,btn('⟳ 更新可见标题','刷新当前页面可见收藏的标题',()=>this.refreshVisibleTitles(),'refresh-titles')));
    this.tab=btn('关注帖','展开收藏面板',()=>this.setMode('expanded',true),'tab');
    this.tab.addEventListener('mouseenter',()=> {if(this.prefs.hover)this.safe(()=>this.setMode('expanded',true))();});
    this.quick=btn('☆ 本地收藏此帖','独立帖子收藏入口',()=>this.saveCurrent(),'quick');
    this.root.append(this.panel,this.tab,this.quick);
    this.header.addEventListener('pointerdown',e=>this.pointerStart(e,'move'));
    this.tab.addEventListener('pointerdown',e=>this.pointerStart(e,'tab'));
    for(const edge of ['n','s','e','w','ne','nw','se','sw']) {
      const h=element('div',{class:'handle','data-edge':edge,'aria-hidden':'true'});h.addEventListener('pointerdown',e=>this.pointerStart(e,edge));this.panel.append(h);
    }
  }
  async setMode(mode,force=false) {
    if(!this.profile) {this.force=true;this.layout();return this.chooseProfile();}
    await this.savePrefs({mode});this.force=force;this.layout();this.updateContext();
  }
  layout() {
    if(!this.panel)return;
    const p=this.prefs,c=this.context;
    let mode=p.mode;
    // Navigation must never rewrite the user-selected expanded/collapsed state.
    // Transient unknown routes during Discord SPA transitions are ignored.
    if(!this.force && c.type==='dm')mode='hidden';
    this.panel.hidden=mode!=='expanded';this.tab.hidden=mode!=='collapsed';
    this.quick.hidden=!(this.profile && c.type==='thread' && mode==='collapsed');
    const rect=geometry(p,{width:innerWidth,height:innerHeight},mode==='collapsed');
    const node=mode==='collapsed'?this.tab:this.panel;
    Object.assign(node.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
    this.host.dataset.glass=p.glass?'on':'off';this.host.dataset.motion=p.motion?'on':'off';
    this.host.style.setProperty('--title-size',`${p.titleSize}px`);this.host.style.setProperty('--ui-size',`${p.uiSize}px`);
    this.host.style.setProperty('--title-lines',String(p.lines || 99999));this.host.style.setProperty('--spacing',({compact:'7px',standard:'10px',relaxed:'15px'})[p.density]);
  }
  async resetLayout() {await this.savePrefs({width:460,height:Math.round(innerHeight*.7),x:1,y:.15,dock:'right',mode:'expanded'});this.force=true;this.layout();}
  pointerStart(event,edge) {
    if(event.button!==0 || (edge==='move' && event.target.closest('button,input,select')))return;
    if(edge==='tab' && !this.profile)return;
    event.preventDefault();const node=edge==='tab'?this.tab:this.panel, start=node.getBoundingClientRect(), sx=event.clientX,sy=event.clientY;
    const pid=event.pointerId;event.currentTarget.setPointerCapture(pid);const owner=event.currentTarget;
    let rect={x:start.x,y:start.y,width:start.width,height:start.height}, moved=false;
    this.panel.classList.add('moving');
    const move=e=> {
      const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>4)moved=true;
      if(edge==='move'||edge==='tab')rect={...rect,x:Math.max(0,Math.min(innerWidth-start.width,start.x+dx)),y:Math.max(0,Math.min(innerHeight-start.height,start.y+dy))};
      else {
        let left=start.x,right=start.right,top=start.y,bottom=start.bottom;
        const minW=Math.min(300,innerWidth-16),minH=Math.min(240,innerHeight*.9);
        if(edge.includes('e'))right=Math.max(left+minW,Math.min(innerWidth,left+760,start.right+dx));
        if(edge.includes('w'))left=Math.min(right-minW,Math.max(0,right-760,start.x+dx));
        if(edge.includes('s'))bottom=Math.max(top+minH,Math.min(innerHeight,top+innerHeight*.9,start.bottom+dy));
        if(edge.includes('n'))top=Math.min(bottom-minH,Math.max(0,bottom-innerHeight*.9,start.y+dy));
        rect={x:left,y:top,width:right-left,height:bottom-top};
      }
      Object.assign(node.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
    };
    const finish=e=> {
      owner.removeEventListener('pointermove',move);owner.removeEventListener('pointerup',finish);owner.removeEventListener('pointercancel',cancel);this.dragCleanup=null;this.panel.classList.remove('moving');
      try{owner.releasePointerCapture(pid);}catch{}
      if(edge==='tab' && !moved)return;
      if(edge==='tab' && moved){const suppress=e=>{e.preventDefault();e.stopImmediatePropagation();};this.tab.addEventListener('click',suppress,{capture:true,once:true});setTimeout(()=>this.tab.removeEventListener('click',suppress,true),0);}
      let dock='none';
      if(this.prefs.snap) {
        const distances=[['left',rect.x],['right',innerWidth-rect.x-rect.width],['top',rect.y],['bottom',innerHeight-rect.y-rect.height]].sort((a,b)=>a[1]-b[1]);
        if(distances[0][1]<=24)dock=distances[0][0];
      }
      const x=Math.max(0,Math.min(1,(rect.x-8)/Math.max(1,innerWidth-rect.width-16))),y=Math.max(0,Math.min(1,(rect.y-8)/Math.max(1,innerHeight-rect.height-16)));
      const patch={x,y,dock};if(edge!=='tab'&&edge!=='move'){patch.width=rect.width;patch.height=rect.height;}
      this.safe(()=>this.savePrefs(patch))();
    };
    const cancel=()=>{owner.removeEventListener('pointermove',move);owner.removeEventListener('pointerup',finish);owner.removeEventListener('pointercancel',cancel);this.panel.classList.remove('moving');this.dragCleanup=null;this.layout();};
    this.dragCleanup=cancel;owner.addEventListener('pointermove',move);owner.addEventListener('pointerup',finish);owner.addEventListener('pointercancel',cancel);
  }
  renderList() {
    if(!this.list)return;const oldScroll=this.list.scrollTop;
    const active=this.root.activeElement, focusKey=active?.getAttribute('data-focus');
    const frag=document.createDocumentFragment();let records=[];
    const guild=this.context.guildId;
    const missingIds=new Set();
    let scannedForums=0;
    if(guild && this.prefs.scanResults)for(const [key,scan] of Object.entries(this.prefs.scanResults)){
      if(!key.startsWith(guild+':'))continue;
      scannedForums++;
      for(const id of scan.missing||[])missingIds.add(guild+':'+id);
    }
    if(this.store && guild)records=selectRecords(this.store.records.values(),{
      ...this.context,...this.currentFilter(),scope:'server',
      missingIds,collectionId:this.selectedFolder().id,query:this.query
    });
    this.count.textContent=records.length+' 条 · 资料库共 '+(this.store?.records.size||0)+' 条'+
      (this.viewMode==='missing'?' · 已检查 '+scannedForums+' 个论坛':'');
    if(!records.length)frag.append(element('div',{class:'empty',text:!this.profile?'选择资料库后即可开始收藏。':!this.context.guildId?'请进入服务器查看收藏。':this.query?'没有匹配的收藏。':this.currentFilter().updates==='changed'?'目前没有尚未查看的标题变化。':this.currentFilter().updates==='missing'?(scannedForums?'当前已检查论坛中，没有未检测到的收藏。':'尚未检查过本服务器的论坛，请进入论坛频道点击更新。'):'此收藏夹在本服务器暂无记录。'}));
    const shortDate=v=>{
      if(v==null)return '—';
      const days=Math.max(0,Math.floor((Date.now()-v)/86400000));
      if(days===0)return '0天';
      if(days<100)return days+'天';
      const d=new Date(v);return (d.getMonth()+1)+'/'+d.getDate();
    };
    for(const r of records.slice(0,this.limit)) {
      const key=identity(r),title=r.customTitle??r.originalTitle;
      const link=element('a',{class:'card-title'+(this.expanded.has(key)||!this.prefs.lines?' full':''),href:r.url,title,'data-focus':key+':open',text:title,onclick:()=>this.captureBookmarkScroll()});
      const star=element('button',{class:'star',text:r.starred?'★':'☆','aria-label':'切换星标','aria-pressed':String(r.starred),onclick:this.safe(()=>this.store.patch(key,{starred:!this.store.records.get(key)?.starred}))});
      const when=element('span',{class:'post-age',title:r.titleUpdatedAt?'上次确认标题变化：'+new Date(r.titleUpdatedAt).toLocaleString():'尚未读取到标题变化时间',text:shortDate(r.titleUpdatedAt)});
      const more=element('button',{class:'more',text:'⋯','aria-label':'帖子更多操作',title:'更多操作','data-focus':key+':more',onclick:this.safe(()=>this.cardMenu(r))});
      const reload=element('button',{class:'reload-title',text:'↻','aria-label':'重新读取标题',title:'重新读取当前可见的帖子标题','data-focus':key+':reload',onclick:this.safe(()=>this.reloadOneTitle(r))});
      star.setAttribute('data-focus',key+':star');
      const starColumn=element('div',{class:'card-side card-side-start'},star,when);
      const actionColumn=element('div',{class:'card-side card-side-end'},more,reload);
      if(r.changeUnread){link.title='标题已变化：'+(r.previousSeenTitle||'未知')+' → '+r.originalTitle;}
      frag.append(element('article',{class:'card compact-card'+(r.changeUnread?' title-changed':''),...(r.changeUnread?{'aria-label':'标题近期发生变化'}:{})},starColumn,link,actionColumn));
    }
    if(records.length>this.limit)frag.append(element('button',{class:'pager',text:`继续显示（剩余 ${records.length-this.limit} 条）`,onclick:()=>{this.limit+=80;this.renderList();}}));
    this.list.replaceChildren(frag);this.list.scrollTop=oldScroll;
    if(focusKey)[...this.list.querySelectorAll('[data-focus]')].find(el=>el.getAttribute('data-focus')===focusKey)?.focus({preventScroll:true});
    this.updateContext();
  }
  async copy(value) {
    try {await navigator.clipboard.writeText(value);this.toast('已复制帖子永久链接。');}
    catch {this.dialog('复制帖子链接',(body)=>body.append(element('input',{value,readonly:true,'aria-label':'可手动复制的永久链接',onfocus:e=>e.target.select()}),element('p',{text:'浏览器阻止了剪贴板访问，请选中并手动复制。'})));}
  }
  async saveCurrent() {
    if(!this.profile)return this.chooseProfile();
    let c=this.adapter.inspect();
    if(c.type==='forum'){this.toast('这是论坛频道，请先打开一个帖子。');return;}
    if(c.type!=='thread'){
      // An explicit one-click save is treated as user confirmation for an otherwise
      // unrecognized /channels/guild/thread URL; unknown parents remain unassigned.
      let parsed;try{parsed=parseLink(this.href());}
      catch{this.toast('当前不是可以收藏的帖子链接。');return;}
      const title=this.adapter.title(this.adapter.main());
      c={...parsed,type:'thread',forumId:null,forumName:'',originalTitle:title||('帖子 '+parsed.threadId),guildName:''};
    }
    if(this.store.records.has(identity(c))){this.toast('当前帖子已经收藏。');return;}
    const folder=this.selectedFolder().id;
    await this.store.add(makeRecord({...c,collectionId:folder},'manual-page'));
    this.toast('已加入「'+this.selectedFolder().name+'」。');
    this.renderList();
  }
  async importVisibleFollowed() {
    if(!this.profile)return this.chooseProfile();
    const candidates=this.adapter.collectVisibleFollowed();
    if(!candidates.length){this.toast('当前可见论坛卡片里没有明确显示已关注的帖子。');return;}
    let added=0;
    for(const candidate of candidates){
      const key=identity(candidate);
      if(!this.store.records.has(key)){
        const result=await this.store.add(makeRecord({...candidate,collectionId:this.selectedFolder().id},'native-follow'),{automatic:true});
        if(result)added++;
      }
    }
    this.toast('新增 '+added+' 条可见关注帖。');
  }
  async capture(c) {
    if(!this.profile||!this.prefs.autoFollow)return;
    if(this.store.records.has(identity(c)))await this.store.observe(c,true);
    else {
      const saved=await this.store.add(makeRecord({...c,collectionId:this.selectedFolder().id},'native-follow'),{automatic:true});
      if(!saved){this.toast('此帖曾被明确删除，自动捕获不会恢复它；需要时请手动重新收藏。');return;}
    }
    this.toast('已观察到关注按钮变为退出状态，并保存本地收藏（实验性）。');
  }
  addDialog(initial='') {
    if(!this.profile)return this.chooseProfile();
    this.dialog('通过链接添加',(body,close,submit)=>{
      const url=element('input',{value:initial,placeholder:'粘贴 Discord 论坛帖子链接','aria-label':'帖子链接'});
      const title=element('input',{maxlength:'20000',placeholder:'标题（可留空）','aria-label':'帖子标题'});
      body.append(element('label',{text:'帖子链接'},url),element('label',{text:'标题（可选）'},title),
        element('button',{class:'primary',text:'加入「'+this.selectedFolder().name+'」',onclick:submit(async()=>{
          const parsed=parseLink(url.value),known=this.store.records.get(identity(parsed));
          if(known){close();this.toast('这条帖子已经收藏。');return;}
          const c=this.adapter.inspect(),matched=this.adapter.links?.get(identity(parsed));
          const info={...parsed,forumId:matched?.forumId||null,forumName:matched?.forumName||'',
            guildName:c.guildId===parsed.guildId?c.guildName||'':'',
            originalTitle:title.value.trim()||'',collectionId:this.selectedFolder().id};
          await this.store.add(makeRecord(info,'manual-link'));
          close();this.toast('收藏成功。');
        })}));
    });
  }
  editDialog(record) {
    const store=this.store;
    this.dialog('编辑收藏',(body,close,submit)=> {
      const title=element('input',{value:record.customTitle??record.originalTitle,maxlength:'20000','aria-label':'自定义标题'});
      const restore=element('input',{type:'checkbox'}),forum=element('input',{value:record.forumId||'','aria-label':'父论坛频道 ID'}),name=element('input',{value:record.forumName,maxlength:'500','aria-label':'父论坛名称'});
      const folder=element('select',{'aria-label':'收藏夹'},...this.prefs.folders.map(f=>element('option',{value:f.id,text:f.name})));folder.value=record.collectionId||'default';
      body.append(element('label',{text:'本地自定义标题'},title),element('label',{text:'收藏夹'},folder),element('p',{class:'notice',text:`原始标题：${record.originalTitle}`}),element('label',{class:'check'},restore,element('span',{text:'恢复原始标题（清除本地自定义名称）'})),
        element('label',{text:'父论坛 ID（留空则待归属）'},forum),element('label',{text:'父论坛名称'},name),element('p',{class:'muted',text:'归属仅由你确认；不会修改 Discord 原帖。'}),
        element('button',{class:'primary',text:'保存修改',onclick:submit(async()=>{
          const fid=forum.value.trim()||null;if(fid&&(!ID.test(fid)||fid===record.threadId))throw new Error('父论坛 ID 不合法。');
          if(!restore.checked&&!title.value.trim())throw new Error('标题不能为空。');
          await store.refresh();if(!store.records.has(identity(record)))throw new Error('该收藏已在其他标签页删除。请重新添加。');
          await store.patch(identity(record),{customTitle:restore.checked?null:title.value,forumId:fid,forumName:fid?name.value.trim():'',collectionId:folder.value});close();this.toast('已保存本地修改。');
        })}));
    });
  }
  deleteDialog(record) {
    const store=this.store;
    this.dialog('删除本地收藏',(body,close,submit)=>body.append(element('p',{text:record.customTitle??record.originalTitle}),element('p',{text:'仅从当前资料库删除，不会退出 Discord 关注，也不会删除原帖。此操作会同步到其他标签页。'}),
      element('div',{class:'row end'},element('button',{text:'取消',onclick:close}),element('button',{class:'danger',text:'确认删除',onclick:submit(async()=>{await store.remove(identity(record));close();this.toast('已删除本地收藏。');})}))));
  }
  async exportNow() {
    if(!this.profile)return this.chooseProfile();
    await this.store.refresh();
    const blob=new Blob([JSON.stringify(exportData(this.store.records.values(),this.profile,this.prefs),null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=element('a',{href:url,download:'Forum-Archive-'+new Date().toISOString().slice(0,10)+'.json'});
    this.root.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    this.toast('已创建 JSON 备份。');
  }
  dataDialog() {
    if(!this.profile)return this.chooseProfile();const store=this.store,profile=this.profile;
    this.dialog('备份与恢复',(body,close,submit)=> {
      const status=element('p',{role:'status'}),file=element('input',{type:'file',accept:'.json,application/json','aria-label':'选择 JSON 备份'});
      let imported=null;
      const policy=element('select',{'aria-label':'导入冲突处理'},element('option',{value:'preserve',text:'保留本地已有记录（默认）'}),element('option',{value:'incoming',text:'使用备份的标题、星标和归属覆盖同名记录'}));
      const importBtn=element('button',{class:'primary',text:'确认合并导入',disabled:true,onclick:submit(async()=>{
        if(!imported)throw new Error('请先选择有效备份文件。');
        try {
          const folders=[...this.prefs.folders];
          for(const f of imported.folders||[]) {
            if(f.id==='default'&&folders[0]?.name==='默认收藏夹')folders[0]={...f};
            else if(!folders.some(x=>x.id===f.id))folders.push(f);
          }
          await this.savePrefs({folders,
            guildAliases:{...imported.guildAliases,...this.prefs.guildAliases},
            forumAliases:{...imported.forumAliases,...this.prefs.forumAliases},
            knownForums:policy.value==='incoming'?
              {...this.prefs.knownForums,...imported.knownForums}:
              {...imported.knownForums,...this.prefs.knownForums}});
          const result=await mergeImport(store,imported.records,policy.value);status.textContent=`导入完成：新增 ${result.added} 条，更新 ${result.updated} 条。`;importBtn.disabled=true;imported=null;}
        catch(e){throw new Error(`导入中断，已完成的记录已保留。可安全重试。${e.message}`);}
      })});
      file.addEventListener('change',this.safe(async()=>{
        imported=null;importBtn.disabled=true;status.textContent='';const selected=file.files[0];if(!selected)return;
        try {if(selected.size>10*1024*1024)throw new Error('JSON 最大为 10 MiB。');imported=parseImport(await selected.text());status.textContent=`来自“${imported.profileName}”：${imported.records.length} 条有效记录，${imported.duplicates} 条重复。将合并到“${profile.name}”。`;importBtn.disabled=false;}
        catch(e){status.textContent=e.message;}
      }));
      body.append(element('p',{text:`资料库：${profile.name} · ${store.records.size} 条收藏。备份仅包含本地收藏与分类，不包含账号凭据。`}),
        element('button',{text:'导出 JSON 备份',onclick:submit(async()=>{
          await store.refresh();const blob=new Blob([JSON.stringify(exportData(store.records.values(),profile,this.prefs),null,2)],{type:'application/json'});
          const url=URL.createObjectURL(blob),a=element('a',{href:url,download:`Forum-Archive-${new Date().toISOString().slice(0,10)}.json`});this.root.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='已生成备份，请确认浏览器下载完成。';
        })}),element('h3',{text:'合并导入'}),file,policy,status,importBtn,
        element('p',{class:'muted',text:'导入逐条写入，存储失败时可能部分完成，重试会去重。覆盖模式会明确替换已有名称、星标和归属；收藏时间保持本地值。备份包含已确认的论坛类型，但不包含界面偏好。'}));
    });
  }
  settings() {
    if(!this.profile)return this.chooseProfile();
    const p=this.prefs;
    this.dialog('Forum Archive 设置',(body,close,submit,box)=>{
      box.classList.add('settings-dialog');
      body.classList.add('settings-body');
      const controls={};
      const select=(key,label,options)=>{
        const el=element('select',{'aria-label':label},...options.map(([value,text])=>element('option',{value,text})));
        el.value=String(p[key]);controls[key]=el;
        return element('label',{class:'settings-field'},element('span',{text:label}),el);
      };
      const number=(key,label,min,max)=>{
        const el=element('input',{type:'number',min,max,step:1,value:p[key],'aria-label':label});
        controls[key]=el;return element('label',{class:'settings-field'},element('span',{text:label}),el);
      };
      const slider=(key,label,min,max)=>{
        const fraction=Math.max(0,Math.min(100,Math.round(100*(p[key]-min)/Math.max(1,max-min))));
        const el=element('input',{type:'range',min:0,max:100,value:fraction,'aria-label':label}),output=element('output',{text:fraction+'%'});
        controls[key]=el;el.addEventListener('input',()=>output.textContent=el.value+'%');
        return element('label',{class:'settings-slider'},element('span',{},element('span',{text:label}),output),el);
      };
      const check=(key,label)=>{
        const el=element('input',{type:'checkbox',checked:p[key]});
        controls[key]=el;return element('label',{class:'settings-check'},el,element('span',{text:label}));
      };
      const group=(title,...children)=>element('section',{class:'settings-group'},
        element('h3',{text:title}),...children);
      const grid=(...children)=>element('div',{class:'settings-grid'},...children);
      const maxWidth=Math.max(300,Math.min(760,innerWidth-16));
      const maxHeight=Math.max(240,Math.min(2000,Math.floor(innerHeight*.9)));
      const panes={
        appearance:element('div',{class:'settings-pane',role:'tabpanel','aria-label':'外观'},
          group('主题与效果',grid(select('theme','配色主题',[['discord','跟随 Discord'],['dark','强制深色'],['light','强制浅色']]),
            select('density','列表密度',[['compact','紧凑'],['standard','标准'],['relaxed','宽松']])),
            check('glass','玻璃质感与柔和高光'),check('motion','启用微动效（尊重系统减少动画设置）')),
          group('字体与标题',grid(number('titleSize','标题字号（12–22 px）',12,22),number('uiSize','界面字号（11–18 px）',11,18)),
            select('lines','标题显示行数',[[1,'单行'],[2,'2 行'],[3,'3 行'],[4,'4 行'],[0,'完整显示']]))),
        layout:element('div',{class:'settings-pane',role:'tabpanel','aria-label':'布局'},
          group('尺寸与位置',slider('width','面板宽度',300,maxWidth),slider('height','面板高度',240,maxHeight),
            select('dock','停靠位置',[['none','自由位置'],['left','左侧'],['right','右侧'],['top','顶部'],['bottom','底部']])),
          group('停靠交互',check('snap','靠近边缘时吸附'),check('hover','悬停标签时展开'),
            element('button',{text:'重置面板位置与尺寸',onclick:submit(async()=>{
              await this.resetLayout();for(const [key,low,high] of [['width',300,maxWidth],['height',240,maxHeight]]){
                controls[key].value=Math.round(100*(this.prefs[key]-low)/Math.max(1,high-low));
                controls[key].dispatchEvent(new Event('input'));
              }controls.dock.value=this.prefs.dock;
            })}))),
        bookmarks:element('div',{class:'settings-pane',role:'tabpanel','aria-label':'收藏与识别'},
          group('收藏默认值',grid(select('defaultSort','默认排序',SORTS.map((value,i)=>[value,['最近收藏','最早收藏','最近修改','最早修改','标题 A–Z','标题 Z–A','星标优先'][i]])))),
          group('识别功能',check('autoFollow','自动记录已确认的原生关注'),
            check('debug','在控制台记录调试事件'))),
        about:element('div',{class:'settings-pane',role:'tabpanel','aria-label':'关于'},
          group('Forum Archive',element('p',{text:'版本 '+VERSION+' · 独立保存 Discord 论坛收藏。'}),
            element('p',{class:'muted',text:'「最近更新」只显示已确认标题变更、尚未标记已查看的收藏。标题检查只读取当前页面可见内容。'}),
            element('p',{class:'muted',text:'收藏记录保存在本地资料库。备份、导入与资料库切换可通过 Tampermonkey 菜单操作。'})))
      };
      const nav=element('nav',{class:'settings-tabs','aria-label':'设置分类'});
      const content=element('div',{class:'settings-panes'});
      const labels=[['appearance','外观'],['layout','布局'],['bookmarks','收藏'],['about','关于']];
      const tabs=[];
      const activate=key=>{
        for(const [id,pane] of Object.entries(panes))pane.hidden=id!==key;
        for(const [id,button] of tabs)button.setAttribute('aria-selected',String(id===key));
        content.scrollTop=0;
      };
      for(const [id,label] of labels){
        const b=element('button',{text:label,role:'tab','aria-selected':'false',onclick:()=>activate(id)});
        tabs.push([id,b]);nav.append(b);content.append(panes[id]);
      }
      activate('appearance');
      const save=element('button',{class:'primary settings-save',text:'保存设置',onclick:submit(async()=>{
        const patch={};
        for(const [key,el] of Object.entries(controls)){
          if(el.type==='checkbox')patch[key]=el.checked;
          else if((key==='width'||key==='height')&&el.type==='range'){
            const low=key==='width'?300:240,high=key==='width'?maxWidth:maxHeight;
            patch[key]=Math.round(low+(high-low)*Number(el.value)/100);
          } else if(el.type==='number'||key==='lines'){
            if(!el.checkValidity())throw new Error('请检查“'+el.getAttribute('aria-label')+'”的范围。');
            patch[key]=Number(el.value);
          } else patch[key]=el.value;
        }
        await this.savePrefs(patch);this.renderList();close();this.toast('设置已保存。');
      })});
      const footer=element('footer',{class:'settings-actions'},element('button',{text:'取消',onclick:close}),save);
      body.append(nav,content,footer);
    });
  }
  applyTheme() {
    if(!this.host)return;const p=this.prefs;
    const dark={bg:'#242429',card:'#2e2e35',fg:'#f2f3f5',muted:'#b6b7c2',line:'#555560',accent:'#5865f2',hover:'#3b3b43'};
    const light={bg:'#ffffff',card:'#f2f3f5',fg:'#202127',muted:'#535460',line:'#b9bbc5',accent:'#4752c4',hover:'#e5e7eb'};
    const main=document.querySelector('main,[role="main"]') || document.body;
    const base=getComputedStyle(main),root=getComputedStyle(document.documentElement);
    let palette=p.theme==='light'?{...light}:{...dark};
    if(p.theme==='discord') {
      const probe=document.createElement('span');probe.style.cssText='display:none';main.append(probe);
      const read=(vars,fallback)=> {
        for(const name of vars) {
          const raw=base.getPropertyValue(name).trim()||root.getPropertyValue(name).trim();
          if(!raw)continue;probe.style.color='';probe.style.color=raw;
          if(!probe.style.color)continue;
          const resolved=getComputedStyle(probe).color;if(resolved && resolved!=='rgba(0, 0, 0, 0)' && resolved!=='transparent')return resolved;
        }return fallback;
      };
      const actual=base.backgroundColor;
      const vars={bg:['--background-base-lowest','--background-primary','--background-base-lower'],card:['--background-surface-high','--background-secondary','--background-base-low'],fg:['--text-default','--text-normal'],muted:['--text-muted','--text-secondary'],line:['--border-subtle','--background-modifier-accent'],accent:['--brand-500','--brand-experiment'],hover:['--background-modifier-hover','--background-surface-higher']};
      palette.bg=read(vars.bg,actual && !actual.endsWith(', 0)') && actual!=='transparent'?actual:dark.bg);
      const luminance=color=> {const nums=color.match(/[\d.]+/g);if(!nums||nums.length<3)return .1;return .2126*Number(nums[0])/255+.7152*Number(nums[1])/255+.0722*Number(nums[2])/255;};
      const fallback=luminance(palette.bg)>.55?light:dark;
      for(const [key,names] of Object.entries(vars))if(key!=='bg')palette[key]=read(names,fallback[key]);
      // Prevent an unreadable text/background combination in partially resolved custom themes.
      if(Math.abs(luminance(palette.fg)-luminance(palette.bg))<.35)palette.fg=fallback.fg;
      probe.remove();
    }
    const signature=JSON.stringify(palette);if(signature===this.themeSignature)return;this.themeSignature=signature;
    for(const [k,v] of Object.entries(palette))this.host.style.setProperty(`--${k}`,v);
    this.host.style.setProperty('--on-accent','#fff');this.host.style.colorScheme=p.theme==='light'?'light':'dark';
  }
  stop() {
    if(this.destroyed)return;this.destroyed=true;this.adapter?.stop();this.themeObserver?.disconnect();this.dragCleanup?.();
    clearInterval(this.syncTimer);clearInterval(this.themeTimer);clearTimeout(this.toastTimer);this.cleanups.forEach(fn=>fn());
    if(this.listener!==undefined)this.storage.unlisten?.(this.listener);this.modalClose?.();this.host?.remove();
  }
}


// ---- main.js ----
// Tampermonkey asynchronous storage supports read-back confirmation and error reporting.
const storage = {
  get: (key,fallback)=>GM.getValue(key,fallback),
  set: (key,value)=>GM.setValue(key,value),
  list: ()=>GM.listValues(),
  listen: (key,callback)=>GM.addValueChangeListener(key,callback),
  unlisten: id=>GM.removeValueChangeListener(id),
  menu: (name,callback)=>GM.registerMenuCommand(name,callback)
};
new ArchiveApp(storage).start().catch(error=> {
  console.error('[Forum Archive] Initialization failed; existing storage was not cleared.');
  alert(`Forum Archive 启动失败：${error.message}\n已有收藏未被清空。请检查 Tampermonkey 权限后刷新。`);
});

})();
