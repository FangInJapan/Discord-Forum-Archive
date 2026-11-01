// Pure data layer. No Discord APIs, browser globals, or whole-database writes.
export const VERSION = '1.3.0';
export const SCHEMA = 1;
export const PREFIX = 'dfa:v1:';
export const ID = /^[0-9]{16,22}$/;
export const FOLDER_ID = /^(?:default|[\w-]{8,100})$/;
export const SOURCES = ['manual-page', 'manual-link', 'native-follow', 'import'];
export const SORTS = ['saved-desc', 'saved-asc', 'modified-desc', 'modified-asc', 'title-asc', 'title-desc', 'starred'];
export const DEFAULTS = Object.freeze({
  theme: 'discord', titleSize: 15, uiSize: 13, lines: 4, density: 'standard',
  snap: true, hover: false, autoFollow: true, debug: false, autoOpen: true, glass: true, motion: true,
  defaultScope: 'forum', defaultSort: 'saved-desc', mode: 'expanded',
  width: 460, height: 580, x: 1, y: 0.15, dock: 'right', filters: {}, scanResults: {},
  folders: [{id:'default',name:'默认收藏夹'}], folderSelections: {}, guildAliases: {}, forumAliases: {}
});
export function uid() { return crypto.randomUUID(); }
export function canonical(guildId, threadId) { return `https://discord.com/channels/${guildId}/${threadId}`; }
export function identity(r) { return `${r.guildId}:${r.threadId}`; }
export function parseLink(value) {
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
export function validateRecord(raw) {
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
export function makeRecord(info, source = 'manual-link', now = Date.now()) {
  return validateRecord({ guildId: info.guildId, threadId: info.threadId,
    forumId: info.forumId || null, guildName: info.guildName || '', forumName: info.forumName || '',
    originalTitle: info.originalTitle || `帖子 ${info.threadId}`, customTitle: null,
    savedAt: now, modifiedAt: now, lastObservedAt: source === 'manual-page' || source === 'native-follow' ? now : null,
    source, starred: false, nativeFollowState: source === 'native-follow' ? 'following' : 'unknown',
    collectionId: info.collectionId || 'default', titleUpdatedAt: info.originalTitle ? now : null, previousSeenTitle:null, titleChangedAt:null, changeUnread:false });
}
export function validatePatch(raw) {
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
export function validateOperation(op) {
  if (!op || op.schemaVersion !== SCHEMA || typeof op.id !== 'string' || !/^[\w-]{8,100}$/.test(op.id) ||
    !Array.isArray(op.stamp) || op.stamp.length !== 3 || !Number.isSafeInteger(op.stamp[0]) || op.stamp[0] < 0 ||
    !Number.isSafeInteger(op.stamp[1]) || op.stamp[1] < 0 || typeof op.stamp[2] !== 'string' || !/^[\w-]{8,100}$/.test(op.stamp[2]) ||
    typeof op.target !== 'string' || !/^\d{16,22}:\d{16,22}$/.test(op.target) || !['put','capture','patch','delete'].includes(op.kind)) throw new Error('变更记录损坏或版本不兼容。');
  if (op.kind === 'put' || op.kind === 'capture') { if (identity(validateRecord(op.value)) !== op.target) throw new Error('记录身份不一致。'); }
  if (op.kind === 'patch') { const p = validatePatch(op.value); if (p.forumId === op.target.split(':')[1]) throw new Error('父论坛不能是帖子自身。'); }
  return op;
}
export function compareStamp(a,b) { return a.stamp[0]-b.stamp[0] || a.stamp[1]-b.stamp[1] || a.stamp[2].localeCompare(b.stamp[2]) || a.id.localeCompare(b.id); }
export function reduceOperations(ops) {
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
export class ArchiveStore {
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
export function compareVisibleForum(records,{guildId,forumId,visibleThreadIds,checkedAt=Date.now()}) {
  if(!ID.test(guildId||'')||!ID.test(forumId||''))throw new Error('请进入可识别的论坛频道。');
  const visible=new Set([...visibleThreadIds].filter(id=>typeof id==='string'&&ID.test(id)));
  if(!visible.size)throw new Error('当前没有可识别的活跃帖子卡片，未生成扫描记录。');
  const scoped=[...records].filter(r=>r.guildId===guildId&&r.forumId===forumId);
  return {checkedAt,visibleCount:visible.size,matchedCount:scoped.filter(r=>visible.has(r.threadId)).length,
    missing:scoped.filter(r=>!visible.has(r.threadId)).map(r=>r.threadId)};
}
export function selectRecords(records, { guildId, forumId, scope = 'server', collectionId = null, updates = 'all', missingIds = new Set(), query = '', sort = 'saved-desc' }) {
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
export function exportData(records, profile, prefs = null) {
  const posts = [...records].map(validateRecord);
  const servers = [...new Map(posts.map(r => [r.guildId,{ guildId:r.guildId,name:r.guildName }])).values()];
  const forums = [...new Map(posts.filter(r=>r.forumId).map(r => [`${r.guildId}:${r.forumId}`,{guildId:r.guildId,forumId:r.forumId,name:r.forumName}])).values()];
  return { format:'discord-forum-archive', schemaVersion:SCHEMA, exportedAt:Date.now(), profile:{id:profile.id,name:profile.name}, servers, forums, records:posts, folders:prefs?.folders || [{id:'default',name:'默认收藏夹'}], guildAliases:prefs?.guildAliases || {}, forumAliases:prefs?.forumAliases || {} };
}
export function parseImport(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 10*1024*1024) throw new Error('JSON 最大为 10 MiB。');
  let data; try { data = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 文件。'); }
  if (!data || data.format !== 'discord-forum-archive' || data.schemaVersion !== SCHEMA || !Array.isArray(data.records) || data.records.length > 10000) throw new Error('格式/版本不支持，或记录超过 10,000 条。');
  const records = new Map();
  for (const raw of data.records) { const r = validateRecord(raw); if (!records.has(identity(r))) records.set(identity(r),r); }
  return { records:[...records.values()], duplicates:data.records.length-records.size, profileName: typeof data.profile?.name === 'string' ? data.profile.name.slice(0,100) : '未命名',
    folders:validateFolders(data.folders), guildAliases:validateAliases(data.guildAliases,false),forumAliases:validateAliases(data.forumAliases,true) };
}
export async function mergeImport(store, records, policy = 'preserve') {
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
export function validateFolders(input) {
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
export function validateAliases(input,forum=false) {
  const result={};
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  const pattern=forum?/^\d{16,22}:\d{16,22}$/:ID;
  for(const [key,value] of Object.entries(input).slice(0,5000)){
    if(pattern.test(key)&&typeof value==='string'&&value.trim()&&value.length<=120)result[key]=value.trim();
  }
  return result;
}
export function cleanPrefs(raw) {
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
  p.guildAliases=validateAliases(raw.guildAliases,false);
  p.forumAliases=validateAliases(raw.forumAliases,true);
  return p;
}
export function geometry(p, viewport, collapsed = false) {
  const pad = 8, vw = Math.max(1,viewport.width), vh = Math.max(1,viewport.height);
  const w = collapsed ? Math.min(40,vw) : Math.min(Math.max(300,p.width),760,Math.max(1,vw-pad*2));
  const h = collapsed ? Math.min(112,vh) : Math.min(Math.max(240,p.height),Math.max(1,Math.floor(vh*0.9)),Math.max(1,vh-pad*2));
  const rx = Math.max(0,vw-w-pad*2), ry = Math.max(0,vh-h-pad*2);
  let x = Math.min(pad,vw-w) + rx*p.x, y = Math.min(pad,vh-h) + ry*p.y;
  if (p.dock === 'left') x = 0; if (p.dock === 'right') x = vw-w;
  if (p.dock === 'top') y = 0; if (p.dock === 'bottom') y = vh-h;
  return {x:Math.max(0,x),y:Math.max(0,y),width:w,height:h};
}
