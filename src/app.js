import {ArchiveStore,canonical,cleanPrefs,compareVisibleForum,exportData,geometry,ID,identity,makeRecord,mergeImport,parseImport,parseLink,PREFIX,SCHEMA,SORTS,uid,VERSION,selectRecords} from './core.js';
import {DiscordAdapter} from './discord.js';
import {STYLE} from './style.js';
// Browser application. All user content is rendered with textContent; no HTML injection.
export function element(tag, attrs = {}, ...children) {
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
export function isolatePanelEvents(root, host = root.host) {
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
export class ArchiveApp {
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
  // A Discord SPA route change should update the selected bookmark in place.
  // Rebuilding the whole list on each thread click would replace DOM nodes,
  // interrupt pointer/focus state and make the panel appear to refresh.
  currentPostIdentity(context=this.context) {
    if(!this.store||!context?.guildId)return null;
    const id=context.type==='thread'?context.threadId:
      context.type==='unknown'?context.channelId:null;
    if(!ID.test(id||''))return null;
    const key=context.guildId+':'+id;
    return this.store.records.has(key)?key:null;
  }
  highlightCurrentPost() {
    if(!this.list?.querySelectorAll)return;
    const selected=this.currentPostIdentity();
    for(const card of this.list.querySelectorAll('article.compact-card[data-post-key]')){
      const active=!!selected&&card.getAttribute('data-post-key')===selected;
      card.classList.toggle('is-current-post',active);
      const link=card.querySelector('a.card-title');
      if(!link)continue;
      if(active)link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
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
    this.updateContext();
    if(nextGuild!==previousGuild){
      this.renderList();
      this.list.scrollTop=nextGuild ? (this.scroll.get(nextGuild)??0) : 0;
    }else{
      this.highlightCurrentPost();
    }
    this.layout();
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
      frag.append(element('article',{class:'card compact-card'+(r.changeUnread?' title-changed':''),'data-post-key':key,...(r.changeUnread?{'aria-label':'标题近期发生变化'}:{})},starColumn,link,actionColumn));
    }
    if(records.length>this.limit)frag.append(element('button',{class:'pager',text:`继续显示（剩余 ${records.length-this.limit} 条）`,onclick:()=>{this.limit+=80;this.renderList();}}));
    this.list.replaceChildren(frag);this.list.scrollTop=oldScroll;
    this.highlightCurrentPost();
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
