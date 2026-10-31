// ==UserScript==
// @name         Discord Forum Archive
// @namespace    https://github.com/FangInJapan/Discord-Forum-Archive
// @version      1.0.1
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
const VERSION = '1.0.1';
const SCHEMA = 1;
const PREFIX = 'dfa:v1:';
const ID = /^[0-9]{16,22}$/;
const SOURCES = ['manual-page', 'manual-link', 'native-follow', 'import'];
const SORTS = ['saved-desc', 'saved-asc', 'modified-desc', 'modified-asc', 'title-asc', 'title-desc', 'starred'];
const DEFAULTS = Object.freeze({
  theme: 'discord', titleSize: 15, uiSize: 13, lines: 4, density: 'standard',
  snap: true, hover: false, autoFollow: true, debug: false, autoOpen: true,
  defaultScope: 'forum', defaultSort: 'saved-desc', mode: 'expanded',
  width: 460, height: 580, x: 1, y: 0.15, dock: 'right', filters: {}
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
    source: raw.source, starred: raw.starred, nativeFollowState: raw.nativeFollowState
  };
}
function makeRecord(info, source = 'manual-link', now = Date.now()) {
  return validateRecord({ guildId: info.guildId, threadId: info.threadId,
    forumId: info.forumId || null, guildName: info.guildName || '', forumName: info.forumName || '',
    originalTitle: info.originalTitle || `帖子 ${info.threadId}`, customTitle: null,
    savedAt: now, modifiedAt: now, lastObservedAt: source === 'manual-page' || source === 'native-follow' ? now : null,
    source, starred: false, nativeFollowState: source === 'native-follow' ? 'following' : 'unknown' });
}
function validatePatch(raw) {
  const allowed = ['forumId', 'forumName', 'guildName', 'originalTitle', 'customTitle', 'starred', 'lastObservedAt', 'nativeFollowState'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('修改字段不合法。');
  const out = {};
  for (const [k,v] of Object.entries(raw)) {
    if (k === 'forumId') { if (v !== null && (typeof v !== 'string' || !ID.test(v))) throw new Error('父频道 ID 不合法。'); }
    else if (k === 'starred') { if (typeof v !== 'boolean') throw new Error('星标格式错误。'); }
    else if (k === 'lastObservedAt') { if (v !== null) time(v, k); }
    else if (k === 'nativeFollowState') { if (!['unknown', 'following'].includes(v)) throw new Error('状态格式错误。'); }
    else if (!(k === 'customTitle' && v === null)) string(v, k, k.endsWith('Name') ? 500 : 20000);
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
    if (info.originalTitle && info.originalTitle !== r.originalTitle) patch.originalTitle = info.originalTitle;
    if (!r.forumId && info.forumId) { patch.forumId = info.forumId; patch.forumName = info.forumName || ''; }
    if (!r.guildName && info.guildName) patch.guildName = info.guildName;
    if (followed && r.nativeFollowState !== 'following') patch.nativeFollowState = 'following';
    if (!Object.keys(patch).length) return r;
    patch.lastObservedAt = Date.now(); return this.patch(identity(r),patch);
  }
}
function selectRecords(records, { guildId, forumId, scope = 'forum', query = '', sort = 'saved-desc' }) {
  const q = query.normalize('NFKC').toLocaleLowerCase();
  const result = [...records].filter(r => r.guildId === guildId && (scope === 'server' || r.forumId === (forumId ?? null)) &&
    [r.customTitle || '',r.originalTitle,r.forumName].some(s => s.normalize('NFKC').toLocaleLowerCase().includes(q)));
  const collator = new Intl.Collator(['zh-CN','ja','en'], { numeric: true, sensitivity: 'base' });
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
function exportData(records, profile) {
  const posts = [...records].map(validateRecord);
  const servers = [...new Map(posts.map(r => [r.guildId,{ guildId:r.guildId,name:r.guildName }])).values()];
  const forums = [...new Map(posts.filter(r=>r.forumId).map(r => [`${r.guildId}:${r.forumId}`,{guildId:r.guildId,forumId:r.forumId,name:r.forumName}])).values()];
  return { format:'discord-forum-archive', schemaVersion:SCHEMA, exportedAt:Date.now(), profile:{id:profile.id,name:profile.name}, servers, forums, records:posts };
}
function parseImport(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 10*1024*1024) throw new Error('JSON 最大为 10 MiB。');
  let data; try { data = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 文件。'); }
  if (!data || data.format !== 'discord-forum-archive' || data.schemaVersion !== SCHEMA || !Array.isArray(data.records) || data.records.length > 10000) throw new Error('格式/版本不支持，或记录超过 10,000 条。');
  const records = new Map();
  for (const raw of data.records) { const r = validateRecord(raw); if (!records.has(identity(r))) records.set(identity(r),r); }
  return { records:[...records.values()], duplicates:data.records.length-records.size, profileName: typeof data.profile?.name === 'string' ? data.profile.name.slice(0,100) : '未命名' };
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
      await store.patch(identity(r),{ customTitle:r.customTitle, starred:r.starred, forumId:r.forumId, forumName:r.forumName, guildName:r.guildName, originalTitle:r.originalTitle }); updated++;
    }
  }
  return {added,updated};
}
function cleanPrefs(raw) {
  const p = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return p;
  for (const [k,opts] of Object.entries({theme:['discord','dark','light'],density:['compact','standard','relaxed'],mode:['expanded','collapsed','hidden'],dock:['none','left','right','top','bottom'],defaultScope:['forum','server'],defaultSort:SORTS})) if (opts.includes(raw[k])) p[k] = raw[k];
  for (const k of ['snap','hover','autoFollow','debug','autoOpen']) if (typeof raw[k] === 'boolean') p[k] = raw[k];
  for (const [k,min,max] of [['titleSize',12,22],['uiSize',11,18],['width',300,760],['height',240,2000],['x',0,1],['y',0,1]]) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) p[k] = Math.max(min,Math.min(max,raw[k]));
  if ([0,1,2,3,4].includes(raw.lines)) p.lines = raw.lines;
  p.filters = {};
  if (raw.filters && typeof raw.filters === 'object') for (const [id,f] of Object.entries(raw.filters)) if (ID.test(id) && f && ['server','forum'].includes(f.scope) && SORTS.includes(f.sort)) p.filters[id] = {scope:f.scope,sort:f.sort};
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
const FOLLOW = /^(Follow(?: Post)?|Join(?: Thread| Post)?|关注(?:帖子)?|關注(?:貼文)?|加入(?:帖子|讨论串|討論串)?|フォロー(?:する)?|参加(?:する)?)$/i;
const UNFOLLOW = /^(Unfollow(?: Post| Thread)?|Leave(?: Thread| Post)?|Following|Joined|取消关注(?:帖子)?|取消關注(?:貼文)?|正在关注|已关注|關注中|已關注|退出(?:帖子|讨论串|討論串)?|フォロー中|フォロー済み|フォロー解除|フォローを解除|参加中|参加済み|参加を取り消す|退出(?:する)?)$/i;
const CREATE = /^(New Post|Create Post|新建帖子|创建帖子|發佈貼文|建立貼文|新しい投稿|投稿を作成)$/i;
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
    this.context = {type:'unknown'}; this.links = new Map(); this.catalog = new Map(); this.knownThreads = new Map();
    this.href=href;this.pending = null; this.lastHref = ''; this.signature = ''; this.timer = null; this.followSerial = 0;
    this.menuTarget = null; this.seenExisting = new Set();
    this.click = this.handleClick.bind(this); this.contextMenu = this.handleContextMenu.bind(this); this.scheduled = () => this.schedule();
  }
  main() { return this.doc.querySelector('main,[role="main"]'); }
  forumRoot(main) {
    return main?.querySelector('[data-list-id*="forum"],[data-forum-channel-id]') ||
      (main && [...main.querySelectorAll('button,[role="button"]')].some(b => visible(b) && CREATE.test(controlLabel(b))) ? main : null);
  }
  title(root) {
    if (!root) return '';
    const heading = [...root.querySelectorAll('header h1,header h2,header h3,[role="toolbar"] h1,[role="toolbar"] h2,[role="toolbar"] h3,h1,h2')].find(visible);
    return (heading?.textContent || '').trim();
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
  // Association is limited to rendered forum post cards. Never infer a post from a random menu.
  postFromNode(node,c=this.context) {
    if(!node?.closest || c.type!=='forum')return null;
    const root=this.forumRoot(this.main());
    if(!root || !root.contains(node))return null;
    const card=node.closest('article,[role="article"],[role="listitem"],[data-list-item-id],[class*="forumPost"],[class*="postCard"]');
    const anchor=node.closest('a[href]'), links=[anchor,...(card?[...card.querySelectorAll('a[href]')]:[])].filter(Boolean);
    for(const link of links) {
      try {
        const parsed=parseLink(link.href);
        if(parsed.guildId!==c.guildId || parsed.threadId===c.forumId)continue;
        const scope=card||link;
        const title=this.title(scope)||link.getAttribute('aria-label')||link.textContent?.trim()||'';
        return {...parsed,forumId:c.forumId,forumName:c.forumName,guildName:c.guildName,originalTitle:title,card:scope};
      }catch{/* Non-post links are not candidates. */}
    }
    return null;
  }
  collectVisibleFollowed() {
    const c=this.inspect(),root=c.type==='forum'?this.forumRoot(this.main()):null,records=new Map();
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
  inspect() {
    const route = routeOf(this.href()), main = this.main();
    if (!route.guildId || !route.channelId) return route;
    const root = this.forumRoot(main), knownForum = this.catalog.get(`${route.guildId}:${route.channelId}`);
    // A selected thread sidebar gets priority over a forum list still visible underneath it.
    const sidebar = [...this.doc.querySelectorAll('[class*="threadSidebar"],[data-thread-id]')].find(visible);
    const candidate = new URL(this.href()).searchParams.get('thread') || sidebar?.getAttribute('data-thread-id');
    const candidateId = candidate && ID.test(candidate) ? candidate : null;
    const known = this.knownThreads.get(`${route.guildId}:${candidateId || route.channelId}`);
    const captured = this.links.get(`${route.guildId}:${candidateId || route.channelId}`);
    const follows = this.controls().filter(b=>!b.closest('[role="menu"]') && (FOLLOW.test(controlLabel(b)) || UNFOLLOW.test(controlLabel(b))));
    const threadMarkup = !!main?.querySelector('[data-thread-id],[class*="threadChat"]');
    const isThread = !!(candidateId || known || captured || (follows.length && !root) || (threadMarkup && !root));
    const guildAnchor = [...this.doc.querySelectorAll('nav a[aria-label],[role="tree"] a[aria-label]')].find(a=>a.getAttribute('href') === `/channels/${route.guildId}`);
    const guildName = guildAnchor?.getAttribute('aria-label') || known?.guildName || captured?.guildName || '';
    if (isThread) {
      const threadId = candidateId || route.channelId;
      const parent = known?.forumId ? known : captured;
      return {...route,type:'thread',threadId,forumId:parent?.forumId || null,forumName:parent?.forumName || '',guildName,
        originalTitle:this.title(sidebar || main) || captured?.originalTitle || known?.originalTitle || '',url:canonical(route.guildId,threadId)};
    }
    if (root || knownForum) return {...route,type:'forum',forumId:route.channelId,forumName:this.title(main) || knownForum?.forumName || route.channelId,guildName};
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
    const positive=()=>card?this.stateIn(card):this.controls().some(b=>!b.closest('[role="menu"]')&&UNFOLLOW.test(controlLabel(b)));
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
.panel{position:fixed;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:13px;box-shadow:0 12px 42px #0005;overflow:hidden;min-width:0;transition:box-shadow .12s}.panel.moving{box-shadow:0 16px 50px #0009;user-select:none}.header{display:flex;align-items:center;gap:5px;padding:11px 12px 8px;cursor:grab;touch-action:none;flex-shrink:0}.header strong{letter-spacing:.2px;flex:1;min-width:0}.icon{padding:3px 7px;min-width:30px;flex-shrink:0}.context{padding:0 13px 9px;overflow-wrap:anywhere;color:var(--muted);font-size:.9em}.tools{padding:0 12px 10px;display:grid;gap:7px;flex-shrink:0}.tools select{min-width:0;flex:1;width:30%}.profile{border:0;text-align:left;padding:0;background:none;color:var(--muted);font-size:.9em;min-height:25px}.list{overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:0;padding:2px 10px 10px;scrollbar-width:thin}.card{border:1px solid var(--line);border-radius:9px;padding:var(--spacing,10px);background:var(--card);margin:0 0 8px;content-visibility:auto;contain-intrinsic-size:auto 140px}.card-title{font-size:var(--title-size,15px);font-weight:600;line-height:1.45;overflow-wrap:anywhere;word-break:normal;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--title-lines,4);overflow:hidden}.card-title.full{display:block;overflow:visible;-webkit-line-clamp:unset}.card-title:hover{text-decoration:underline}.meta{font-size:.85em;color:var(--muted);overflow-wrap:anywhere;margin:6px 0}.actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.actions button{font-size:.85em;min-height:27px;padding:2px 7px}.star[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}.empty{padding:28px 10px;text-align:center;color:var(--muted)}.footer{padding:7px 12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.85em;color:var(--muted)}.footer button{font-size:inherit;padding:1px 6px;min-height:24px}.tab{position:fixed;width:40px;height:92px;padding:7px 4px;white-space:nowrap;writing-mode:vertical-rl;text-orientation:upright;letter-spacing:1px;border-radius:9px;box-shadow:0 4px 20px #0004;background:var(--bg);color:var(--fg)}.quick{position:fixed;right:16px;top:12px;max-width:min(300px,90vw);box-shadow:0 3px 15px #0005;background:var(--bg)}
.handle{position:absolute;touch-action:none;z-index:2}.handle[data-edge=n],.handle[data-edge=s]{height:6px;left:12px;right:12px;cursor:ns-resize}.handle[data-edge=n]{top:0}.handle[data-edge=s]{bottom:0}.handle[data-edge=e],.handle[data-edge=w]{width:6px;top:12px;bottom:12px;cursor:ew-resize}.handle[data-edge=e]{right:0}.handle[data-edge=w]{left:0}.handle[data-edge=ne],.handle[data-edge=nw],.handle[data-edge=se],.handle[data-edge=sw]{width:12px;height:12px}.handle[data-edge=ne]{right:0;top:0;cursor:nesw-resize}.handle[data-edge=nw]{left:0;top:0;cursor:nwse-resize}.handle[data-edge=se]{right:0;bottom:0;cursor:nwse-resize;background:linear-gradient(135deg,transparent 65%,var(--line) 66%,var(--line) 75%,transparent 76%)}.handle[data-edge=sw]{left:0;bottom:0;cursor:nesw-resize}
.overlay{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}.dialog{width:520px;max-width:100%;max-height:92vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:13px;padding:18px;box-shadow:0 20px 80px #0008}.dialog label{display:grid;gap:4px}.dialog label.check{display:flex;align-items:start;gap:8px}.dialog label.check input{margin-top:5px}.dialog .error{color:var(--fg);border-left:3px solid #ef6376;padding-left:8px;white-space:pre-wrap;overflow-wrap:anywhere}.dialog .row.end{justify-content:flex-end;margin-top:14px}.dialog header{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);max-width:min(600px,95vw);background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:11px 16px;box-shadow:0 7px 25px #0006;white-space:pre-wrap;overflow-wrap:anywhere}.toast.error{border-color:#ef6376}.pager{width:100%}details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer;padding:5px;border-radius:5px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}`;


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
class ArchiveApp {
  constructor(storage, href = ()=>location.href) {
    this.storage = storage; this.prefs = cleanPrefs(); this.context = {type:'unknown'}; this.profile = null; this.store = null;
    this.query = ''; this.limit = 80; this.expanded = new Set(); this.scroll = new Map(); this.force = false; this.destroyed = false;
    this.href=href;this.cleanups = []; this.lastRouteKey = ''; this.modalClose = null; this.prefQueue = Promise.resolve(); this.revision = 0;
    this.log = event=> { if (this.prefs.debug) console.debug('[Forum Archive]',event); };
    this.safe = fn=> (...args)=> Promise.resolve().then(()=>fn(...args)).catch(e=>this.report(e));
  }
  async start() {
    if (document.getElementById('dfa-root')) return;
    this.host = element('div',{id:'dfa-root'}); this.host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
    this.root = this.host.attachShadow({mode:'open'}); const style = element('style',{text:STYLE+' .panel,.tab,.overlay,.toast,.quick{pointer-events:auto}'});
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
      if (id === this.profile?.id) { this.prefs = next; this.layout(); this.applyTheme(); }
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
    queueMicrotask(()=> { (box.querySelector('input,select') || box.querySelector('button') || box).focus(); });
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
      body.append(element('p',{text:'无法从网页可靠识别账号。请为每个 Discord 账号单独创建并选择资料库；切换账号后也请在此切换。每次刷新均需明确选择，不会自动混合账号数据。'}));
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
    this.profile=profile;this.prefs=nextPrefs;this.store=nextStore;this.revision++;this.query='';this.search.value='';this.expanded.clear();this.scroll.clear();
    this.force=false;this.changed();this.layout();this.applyTheme();this.adapter.scan();
  }
  changed() {
    this.adapter.seed(this.store?.records.values() || []);this.adapter.schedule();this.renderList();this.updateContext();
    if (this.store?.invalidCount) this.toast(`检测到 ${this.store.invalidCount} 条无法读取的变更，已保留原数据。请导出可读取记录并保留 Tampermonkey 备份。`,true);
  }
  async navigate(c) {
    const old=this.context, oldKey=`${old.guildId}:${old.forumId || old.channelId}`;
    this.scroll.set(oldKey,this.list.scrollTop);
    this.context=c; const key=`${c.guildId}:${c.forumId || c.channelId}`;
    if(key!==oldKey) {this.force=false;this.query='';this.search.value='';this.limit=80;}
    this.updateContext();this.renderList();this.layout();this.list.scrollTop=this.scroll.get(key)||0;
    if(c.type==='thread' && this.store) await this.store.observe(c);
  }
  currentFilter() {
    return this.prefs.filters[this.context.guildId] || {scope:this.prefs.defaultScope,sort:this.prefs.defaultSort};
  }
  async filterChange() {
    if(!this.profile)return this.chooseProfile();
    const filters={...this.prefs.filters,[this.context.guildId]:{scope:this.scope.value,sort:this.sort.value}};
    await this.savePrefs({filters});this.limit=80;this.renderList();
  }
  updateContext() {
    const c=this.context,f=this.currentFilter();
    this.contextEl.textContent=c.guildId ? `${c.guildName || `服务器 ${c.guildId}`} · ${c.forumName || (c.type==='thread'?'待归属':c.type==='forum'?c.forumId:'未识别论坛')}` : '私信 / 非服务器页面';
    this.profileEl.textContent=this.profile ? `资料库：${this.profile.name} · 切换账号时请切换资料库` : '尚未选择资料库 · 点击选择';
    this.scope.value=f.scope;this.sort.value=f.sort;
    const saved=this.store && c.type==='thread' && this.store.records.has(identity(c));
    this.quick.textContent=saved?'★ 已本地收藏 · 管理':'☆ 本地收藏此帖';
    this.pageSave.textContent=c.type==='thread'?'收藏当前帖子':'添加当前链接…';
  }
  buildPanel() {
    const btn=(text,label,fn,cls='icon')=>element('button',{text,'aria-label':label,title:label,class:cls,onclick:this.safe(fn)});
    this.panel=element('section',{class:'panel','aria-label':'Forum Archive 收藏管理'});
    this.header=element('header',{class:'header'},element('strong',{text:'Forum Archive'}),
      btn('+','添加帖子链接',()=>this.addDialog()),btn('⚙','设置',()=>this.settings()),btn('−','折叠面板',()=>this.setMode('collapsed')),btn('×','隐藏面板',()=>this.setMode('hidden')));
    this.contextEl=element('div',{class:'context'});this.profileEl=element('div',{class:'profile'});
    this.search=element('input',{type:'search',placeholder:'搜索标题 / 论坛名称','aria-label':'搜索收藏'});
    this.search.addEventListener('input',()=> {this.query=this.search.value;this.limit=80;this.renderList();});
    this.scope=element('select',{'aria-label':'筛选范围'},element('option',{value:'forum',text:'本频道 / 待归属'}),element('option',{value:'server',text:'整个服务器'}));
    const names=['收藏时间 ↓','收藏时间 ↑','修改时间 ↓','修改时间 ↑','标题 A → Z','标题 Z → A','星标优先'];
    this.sort=element('select',{'aria-label':'排序'},...SORTS.map((v,i)=>element('option',{value:v,text:names[i]})));
    this.scope.addEventListener('change',this.safe(()=>this.filterChange()));this.sort.addEventListener('change',this.safe(()=>this.filterChange()));
    this.pageSave=btn('收藏当前帖子','收藏当前页面或添加链接',()=>this.saveCurrent(),'grow');
    this.list=element('div',{class:'list',role:'region','aria-label':'收藏列表',tabindex:'0'});
    this.count=element('span',{role:'status'});
    this.panel.append(this.header,this.contextEl,element('div',{class:'tools'},this.profileEl,this.search,element('div',{class:'row'},this.scope,this.sort),this.pageSave),this.list,
      element('footer',{class:'footer'},this.count,btn('备份 / 恢复','数据导入导出',()=>this.dataDialog(),'')));
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
    if(!this.force && mode!=='hidden') {
      if(c.type==='dm')mode='hidden';
      else if(c.type!=='forum' && c.type!=='thread')mode='collapsed';
      else if(!p.autoOpen)mode='collapsed';
    }
    this.panel.hidden=mode!=='expanded';this.tab.hidden=mode!=='collapsed';
    this.quick.hidden=!(this.profile && c.type==='thread' && mode==='collapsed');
    const rect=geometry(p,{width:innerWidth,height:innerHeight},mode==='collapsed');
    const node=mode==='collapsed'?this.tab:this.panel;
    Object.assign(node.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
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
    if(this.store && this.context.guildId)records=selectRecords(this.store.records.values(),{...this.context,...this.currentFilter(),query:this.query});
    this.count.textContent=`${records.length} 条 · 资料库共 ${this.store?.records.size || 0} 条`;
    if(!records.length)frag.append(element('div',{class:'empty',text:!this.profile?'选择资料库后即可开始收藏。':!this.context.guildId?'请进入服务器查看收藏。':this.query?'没有匹配的收藏。':this.context.forumId?'此筛选下还没有收藏。':'此页未确定父论坛；显示本服务器待归属收藏。可切换“整个服务器”。'}));
    const date=v=>new Date(v).toLocaleString();
    const source={'manual-page':'页面收藏','manual-link':'链接添加','native-follow':'原生关注 · 实验性',import:'导入'};
    for(const r of records.slice(0,this.limit)) {
      const key=identity(r),title=r.customTitle??r.originalTitle;
      const link=element('a',{class:`card-title${this.expanded.has(key)||!this.prefs.lines?' full':''}`,href:r.url,title,'data-focus':`${key}:open`,text:title});
      const small=(text,label,action)=>element('button',{text,title:label,'aria-label':label,'data-focus':`${key}:${label}`,onclick:this.safe(action)});
      const star=small(r.starred?'★':'☆','切换星标',()=>this.store.patch(key,{starred:!this.store.records.get(key)?.starred}));star.className='star';star.setAttribute('aria-pressed',String(r.starred));
      const actions=element('div',{class:'actions'},star,
        small(this.expanded.has(key)?'收起标题':'全文','展开或收起完整标题',()=>{this.expanded.has(key)?this.expanded.delete(key):this.expanded.add(key);this.renderList();}),
        small('复制','复制帖子永久链接',()=>this.copy(r.url)),small('编辑','编辑标题和归属',()=>this.editDialog(r)),small('删除','仅删除本地收藏',()=>this.deleteDialog(r)));
      frag.append(element('article',{class:'card'},link,element('div',{class:'meta',text:`${r.forumName || (r.forumId?`论坛 ${r.forumId}`:'待归属')} · ${source[r.source]}`}),
        element('div',{class:'meta',text:`收藏 ${date(r.savedAt)} · 修改 ${date(r.modifiedAt)}`}),actions));
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
    const c=this.adapter.inspect();
    if(c.type!=='thread')return this.addDialog(this.href());
    if(this.store.records.has(identity(c)))return this.editDialog(this.store.records.get(identity(c)));
    await this.store.add(makeRecord(c,'manual-page'));this.toast('已保存到本地资料库；退出原生关注也会保留。');this.renderList();
  }
  async importVisibleFollowed() {
    if(!this.profile)return this.chooseProfile();
    const candidates=this.adapter.collectVisibleFollowed();
    if(!candidates.length){this.toast('当前可见论坛卡片中没有能够明确确认已关注的帖子；无法读取未渲染或已失去关注状态的历史帖子。');return;}
    let added=0;
    for(const candidate of candidates){
      const key=identity(candidate);
      if(!this.store.records.has(key)){
        const result=await this.store.add(makeRecord(candidate,'native-follow'),{automatic:true});
        if(result)added++;
      }
    }
    this.toast(`已从可见且有明确已关注标记的帖子中新增 ${added} 条，本次发现 ${candidates.length} 条。`);
  }
  async capture(c) {
    if(!this.profile||!this.prefs.autoFollow)return;
    if(this.store.records.has(identity(c)))await this.store.observe(c,true);
    else {
      const saved=await this.store.add(makeRecord(c,'native-follow'),{automatic:true});
      if(!saved){this.toast('此帖曾被明确删除，自动捕获不会恢复它；需要时请手动重新收藏。');return;}
    }
    this.toast('已观察到关注按钮变为退出状态，并保存本地收藏（实验性）。');
  }
  addDialog(initial='') {
    if(!this.profile)return this.chooseProfile();
    this.dialog('添加帖子链接',(body,close,submit)=> {
      const url=element('input',{value:initial,placeholder:'https://discord.com/channels/服务器ID/帖子ID','aria-label':'Discord 帖子链接'});
      const title=element('input',{maxlength:'20000',placeholder:'可留空，稍后修改','aria-label':'帖子标题'});
      const forum=element('input',{placeholder:'父论坛频道 ID，可留空','aria-label':'父论坛频道 ID'});
      const forumName=element('input',{maxlength:'500',placeholder:'父论坛名称，可留空','aria-label':'父论坛名称'});
      // Link ID validation remains mandatory; no redundant confirmation checkbox.
      body.append(element('label',{text:'帖子永久链接'},url),element('label',{text:'标题'},title),element('label',{text:'父论坛 ID'},forum),element('label',{text:'父论坛名称'},forumName),
        element('p',{class:'muted',text:'请输入论坛帖子链接。无法从链接确定帖子类型或父论坛时，将记录标为待归属；请在收藏后核对。'}),
        element('button',{class:'primary',text:'保存收藏',onclick:submit(async()=>{
                    const parsed=parseLink(url.value),fid=forum.value.trim()||null;
          if(fid && (!ID.test(fid)||fid===parsed.threadId))throw new Error('父论坛 ID 必须是不同于帖子 ID 的 Snowflake 字符串。');
          const known=this.store.records.get(identity(parsed));
          if(known){close();this.toast('已收藏该帖子，没有创建重复记录。');return;}
          await this.store.add(makeRecord({...parsed,forumId:fid,forumName:fid?forumName.value.trim():'',originalTitle:title.value.trim()},'manual-link'));
          close();this.toast('已保存本地收藏。');
        })}));
    });
  }
  editDialog(record) {
    const store=this.store;
    this.dialog('编辑收藏',(body,close,submit)=> {
      const title=element('input',{value:record.customTitle??record.originalTitle,maxlength:'20000','aria-label':'自定义标题'});
      const restore=element('input',{type:'checkbox'}),forum=element('input',{value:record.forumId||'','aria-label':'父论坛频道 ID'}),name=element('input',{value:record.forumName,maxlength:'500','aria-label':'父论坛名称'});
      body.append(element('label',{text:'本地自定义标题'},title),element('p',{class:'notice',text:`原始标题：${record.originalTitle}`}),element('label',{class:'check'},restore,element('span',{text:'恢复原始标题（清除本地自定义名称）'})),
        element('label',{text:'父论坛 ID（留空则待归属）'},forum),element('label',{text:'父论坛名称'},name),element('p',{class:'muted',text:'归属仅由你确认；不会修改 Discord 原帖。'}),
        element('button',{class:'primary',text:'保存修改',onclick:submit(async()=>{
          const fid=forum.value.trim()||null;if(fid&&(!ID.test(fid)||fid===record.threadId))throw new Error('父论坛 ID 不合法。');
          if(!restore.checked&&!title.value.trim())throw new Error('标题不能为空。');
          await store.refresh();if(!store.records.has(identity(record)))throw new Error('该收藏已在其他标签页删除。请重新添加。');
          await store.patch(identity(record),{customTitle:restore.checked?null:title.value,forumId:fid,forumName:fid?name.value.trim():''});close();this.toast('已保存本地修改。');
        })}));
    });
  }
  deleteDialog(record) {
    const store=this.store;
    this.dialog('删除本地收藏',(body,close,submit)=>body.append(element('p',{text:record.customTitle??record.originalTitle}),element('p',{text:'仅从当前资料库删除，不会退出 Discord 关注，也不会删除原帖。此操作会同步到其他标签页。'}),
      element('div',{class:'row end'},element('button',{text:'取消',onclick:close}),element('button',{class:'danger',text:'确认删除',onclick:submit(async()=>{await store.remove(identity(record));close();this.toast('已删除本地收藏。');})}))));
  }
  dataDialog() {
    if(!this.profile)return this.chooseProfile();const store=this.store,profile=this.profile;
    this.dialog('备份与恢复',(body,close,submit)=> {
      const status=element('p',{role:'status'}),file=element('input',{type:'file',accept:'.json,application/json','aria-label':'选择 JSON 备份'});
      let imported=null;
      const policy=element('select',{'aria-label':'导入冲突处理'},element('option',{value:'preserve',text:'保留本地已有记录（默认）'}),element('option',{value:'incoming',text:'使用备份的标题、星标和归属覆盖同名记录'}));
      const importBtn=element('button',{class:'primary',text:'确认合并导入',disabled:true,onclick:submit(async()=>{
        if(!imported)throw new Error('请先选择有效备份文件。');
        try {const result=await mergeImport(store,imported.records,policy.value);status.textContent=`导入完成：新增 ${result.added} 条，更新 ${result.updated} 条。`;importBtn.disabled=true;imported=null;}
        catch(e){throw new Error(`导入中断，已完成的记录已保留。可安全重试。${e.message}`);}
      })});
      file.addEventListener('change',this.safe(async()=>{
        imported=null;importBtn.disabled=true;status.textContent='';const selected=file.files[0];if(!selected)return;
        try {if(selected.size>10*1024*1024)throw new Error('JSON 最大为 10 MiB。');imported=parseImport(await selected.text());status.textContent=`来自“${imported.profileName}”：${imported.records.length} 条有效记录，${imported.duplicates} 条重复。将合并到“${profile.name}”。`;importBtn.disabled=false;}
        catch(e){status.textContent=e.message;}
      }));
      body.append(element('p',{text:`资料库：${profile.name} · ${store.records.size} 条收藏。备份仅包含本地收藏与分类，不包含账号凭据。`}),
        element('button',{text:'导出 JSON 备份',onclick:submit(async()=>{
          await store.refresh();const blob=new Blob([JSON.stringify(exportData(store.records.values(),profile),null,2)],{type:'application/json'});
          const url=URL.createObjectURL(blob),a=element('a',{href:url,download:`Forum-Archive-${new Date().toISOString().slice(0,10)}.json`});this.root.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='已生成备份，请确认浏览器下载完成。';
        })}),element('h3',{text:'合并导入'}),file,policy,status,importBtn,
        element('p',{class:'muted',text:'导入逐条写入，存储失败时可能部分完成，重试会去重。覆盖模式会明确替换已有名称、星标和归属；收藏时间保持本地值。备份不包含界面偏好。'}));
    });
  }
  settings() {
    if(!this.profile)return this.chooseProfile();const p=this.prefs;
    this.dialog('Forum Archive 设置',(body,close,submit)=> {
      const controls={};
      const select=(key,label,options)=> {const el=element('select',{'aria-label':label},...options.map(([value,text])=>element('option',{value,text})));el.value=String(p[key]);controls[key]=el;return element('label',{text:label},el);};
      const number=(key,label,min,max)=> {const el=element('input',{type:'number',min,max,step:1,value:p[key],'aria-label':label});controls[key]=el;return element('label',{text:label},el);};
      const check=(key,label)=> {const el=element('input',{type:'checkbox',checked:p[key]});controls[key]=el;return element('label',{class:'check'},el,element('span',{text:label}));};
      body.append(element('h3',{text:'外观'}),select('theme','主题',[['discord','跟随 Discord'],['dark','强制深色'],['light','强制浅色']]),
        element('div',{class:'row'},number('titleSize','标题字号（12–22 px）',12,22),number('uiSize','界面字号（11–18 px）',11,18)),
        select('lines','标题显示行数',[[1,'单行'],[2,'2 行'],[3,'3 行'],[4,'4 行'],[0,'完整显示']]),select('density','列表密度',[['compact','紧凑'],['standard','标准'],['relaxed','宽松']]),
        element('h3',{text:'布局'}),element('div',{class:'row'},number('width','宽度（300–760 px）',300,760),number('height','高度（按视口限制）',240,2000)),
        select('dock','停靠位置',[['none','自由位置'],['left','左侧'],['right','右侧'],['top','顶部'],['bottom','底部']]),check('snap','拖动到距离边缘 24 px 内时吸附'),check('hover','悬停停靠标签时展开（默认关闭）'),check('autoOpen','进入已识别论坛时显示面板（保留手动折叠/隐藏）'),
        element('button',{text:'重置位置与尺寸',onclick:submit(async()=>{await this.resetLayout();controls.width.value=this.prefs.width;controls.height.value=this.prefs.height;controls.dock.value=this.prefs.dock;})}),
        element('h3',{text:'收藏与识别'}),select('defaultScope','新服务器默认筛选',[['forum','本频道'],['server','整个服务器']]),select('defaultSort','新服务器默认排序',SORTS.map((s,i)=>[s,['收藏时间 ↓','收藏时间 ↑','修改时间 ↓','修改时间 ↑','标题 A → Z','标题 Z → A','星标优先'][i]])),
        check('autoFollow','实验性：原生关注成功后记录本地收藏'),check('debug','控制台输出无标题、ID、链接的调试事件'),
        element('p',{class:'notice',text:'自动关注识别为部分支持，默认关闭。仅观察当前帖子中由你点击的关注按钮稳定变为退出状态；不保证服务器已最终确认。右键菜单、控件替换、无可见确认信号时请手动收藏。中/日/英标签规则仅经模拟测试，未在真实账号中验证。'}),
        element('h3',{text:'数据与关于'}),element('button',{text:'备份 / 恢复 JSON',onclick:this.safe(()=>this.dataDialog())}),element('p',{class:'muted',text:'资料库切换：请使用 Tampermonkey 扩展菜单中的“切换本地资料库 / 账号”。'}),
        element('p',{class:'muted',text:`Discord Forum Archive ${VERSION} · 本地数据格式 ${SCHEMA}。不读取 Token/Cookie，不调用 Discord API，不上传收藏。资料库需手动选择。逐变更日志合并，保留完整标题和删除记录；同一字段并发修改按逻辑时钟确定顺序，无法提供严格事务。日志随编辑次数增长，请定期导出备份。`} ),
        element('p',{class:'muted',text:'页面识别依赖可见 DOM，Discord 更新可能影响兼容性。主题读取可用 CSS 变量；复杂主题近似为纯色。网页注入有兼容和服务规则风险，本项目不代表 Discord 官方许可。'}),
        element('button',{class:'primary',text:'保存设置',onclick:submit(async()=>{
          const patch={};for(const [key,el] of Object.entries(controls)) {
            if(el.type==='checkbox')patch[key]=el.checked;
            else if(el.type==='number'||key==='lines'){if(!el.checkValidity())throw new Error(`请检查“${el.getAttribute('aria-label')}”的范围。`);patch[key]=Number(el.value);}
            else patch[key]=el.value;
          }
          await this.savePrefs(patch);this.renderList();close();this.toast('设置已保存。');
        })}));
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
