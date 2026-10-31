import {ArchiveStore,canonical,cleanPrefs,exportData,geometry,ID,identity,makeRecord,mergeImport,parseImport,parseLink,PREFIX,SCHEMA,SORTS,uid,VERSION,selectRecords} from './core.js';
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
    this.query = ''; this.limit = 80; this.expanded = new Set(); this.scroll = new Map(); this.force = false; this.destroyed = false;
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
    if(key!==oldKey) {this.query='';this.search.value='';this.limit=80;}
    this.updateContext();this.renderList();this.layout();this.list.scrollTop=this.scroll.get(key)||0;
    if(c.type==='thread' && this.store) await this.store.observe(c);
  }
  currentFilter() {
    return {...{scope:this.prefs.defaultScope,sort:this.prefs.defaultSort,updates:'all'},...(this.prefs.filters[this.context.guildId]||{})};
  }
  async filterChange() {
    if(!this.profile)return this.chooseProfile();
    const filters={...this.prefs.filters,[this.context.guildId]:{scope:this.scope.value,sort:this.sort.value,updates:this.updateToggle.value}};
    await this.savePrefs({filters});this.limit=80;this.renderList();
  }
  updateContext() {
    const c=this.context,f=this.currentFilter();
    const guildName=this.prefs.guildAliases[c.guildId]||c.guildName||(c.guildId?'服务器 '+c.guildId:'非服务器页面');
    const forumId=c.forumId || (c.type==='forum'?c.channelId:null);
    const forumName=this.prefs.forumAliases[c.guildId+':'+forumId]||c.forumName||(forumId?'频道 '+forumId:'当前频道');
    this.contextEl.textContent=c.guildId ? guildName+' · '+forumName : '私信 / 非服务器页面';
    this.profileEl.textContent=this.profile ? this.profile.name : '';
    this.scope.value=f.scope; this.scope.textContent=f.scope==='forum'?'本频道':'全服务器';
    this.scope.setAttribute('aria-checked',String(f.scope==='server'));
    this.updateToggle.value=f.updates==='changed'?'changed':'all';
    this.updateToggle.textContent=f.updates==='changed'?'最近更新':'全部';
    this.updateToggle.setAttribute('aria-checked',String(f.updates==='changed'));
    this.updateToggle.title=f.updates==='changed'?'只显示标题发生变化且尚未标记已查看的帖子':'显示全部收藏';
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
        element('button',{class:'primary',text:'保存',onclick:submit(async()=>{
          const ga={...this.prefs.guildAliases},fa={...this.prefs.forumAliases};
          if(guild.value.trim())ga[c.guildId]=guild.value.trim();else delete ga[c.guildId];
          if(fid){if(forum.value.trim())fa[key]=forum.value.trim();else delete fa[key];}
          await this.savePrefs({guildAliases:ga,forumAliases:fa});this.updateContext();close();
        })}));
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
    if(Date.now()-(this.lastTitleRefresh||0)<60000){this.toast('请稍后再刷新标题。');return;}
    const posts=this.adapter.collectVisiblePosts();
    let changed=0,seen=0;
    for(const info of posts){
      const existing=this.store.records.get(identity(info));
      if(!existing)continue;
      seen++;
      if(info.originalTitle && info.originalTitle!==existing.originalTitle){
        await this.store.observe(info);changed++;
      }
    }
    this.lastTitleRefresh=Date.now();
    this.toast('已检查 '+seen+' 个当前可见的收藏，更新 '+changed+' 个标题。未后台请求其他帖子。');
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
    this.scope=element('button',{class:'scope-toggle',role:'switch','aria-label':'切换本频道或全服务器',onclick:this.safe(async()=>{
      this.scope.value=this.scope.value==='forum'?'server':'forum';await this.filterChange();
    })});
    this.scope.value='forum';
    this.updateToggle=element('button',{class:'update-toggle',role:'switch','aria-label':'全部或最近更新',onclick:this.safe(async()=>{
      this.updateToggle.value=this.updateToggle.value==='changed'?'all':'changed';await this.filterChange();
    })});this.updateToggle.value='all';
    this.collectionButton=element('button',{class:'collection-select',title:'选择或管理收藏夹',onclick:this.safe(()=>this.folderDialog())});
    this.sort=element('select',{'aria-label':'排序方式'},...SORTS.map((v,i)=>element('option',{value:v,text:['收藏时间 ↓','收藏时间 ↑','修改时间 ↓','修改时间 ↑','标题 A→Z','标题 Z→A','星标优先'][i]})));
    this.sort.addEventListener('change',this.safe(()=>this.filterChange()));
    const sortSlot=element('div',{class:'sort-slot',title:'选择排序方式'},element('span',{text:'⇅'}),this.sort);
    this.pageSave=btn('☆ 收藏当前帖子','一键收藏当前帖子',()=>this.saveCurrent(),'page-save');
    this.list=element('div',{class:'list',role:'region','aria-label':'收藏列表',tabindex:'0'});
    this.count=element('span',{role:'status'});
    this.panel.append(this.header,this.contextEl,
      element('div',{class:'tools'},this.search,element('div',{class:'filters'},this.scope,this.updateToggle,this.collectionButton,sortSlot),this.pageSave),
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
    if(this.store && this.context.guildId)records=selectRecords(this.store.records.values(),{...this.context,...this.currentFilter(),collectionId:this.selectedFolder().id,query:this.query});
    this.count.textContent=`${records.length} 条 · 资料库共 ${this.store?.records.size || 0} 条`;
    if(!records.length)frag.append(element('div',{class:'empty',text:!this.profile?'选择资料库后即可开始收藏。':!this.context.guildId?'请进入服务器查看收藏。':this.query?'没有匹配的收藏。':this.currentFilter().updates==='changed'?'目前没有尚未查看的标题变化。':this.context.forumId?'此筛选下还没有收藏。':'此页未确定父论坛；显示本服务器待归属收藏。可切换“整个服务器”。'}));
    const shortDate=v=>{
      if(v==null)return '—';
      const days=Math.max(0,Math.floor((Date.now()-v)/86400000));
      if(days===0)return '0天';
      if(days<100)return days+'天';
      const d=new Date(v);return (d.getMonth()+1)+'/'+d.getDate();
    };
    for(const r of records.slice(0,this.limit)) {
      const key=identity(r),title=r.customTitle??r.originalTitle;
      const link=element('a',{class:'card-title'+(this.expanded.has(key)||!this.prefs.lines?' full':''),href:r.url,title,'data-focus':key+':open',text:title});
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
            forumAliases:{...imported.forumAliases,...this.prefs.forumAliases}});
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
        element('p',{class:'muted',text:'导入逐条写入，存储失败时可能部分完成，重试会去重。覆盖模式会明确替换已有名称、星标和归属；收藏时间保持本地值。备份不包含界面偏好。'}));
    });
  }
  settings() {
    if(!this.profile)return this.chooseProfile();const p=this.prefs;
    this.dialog('Forum Archive 设置',(body,close,submit)=> {
      const controls={};
      const select=(key,label,options)=> {const el=element('select',{'aria-label':label},...options.map(([value,text])=>element('option',{value,text})));el.value=String(p[key]);controls[key]=el;return element('label',{text:label},el);};
      const number=(key,label,min,max)=> {const el=element('input',{type:'number',min,max,step:1,value:p[key],'aria-label':label});controls[key]=el;return element('label',{text:label},el);};
      const sizeSlider=(key,label,min,max)=>{
        const current=Math.round(100*(p[key]-min)/Math.max(1,max-min));
        const el=element('input',{type:'range',min:0,max:100,step:1,value:Math.max(0,Math.min(100,current)),'aria-label':label});
        controls[key]=el;
        const output=element('output',{text:el.value+'%'});
        el.addEventListener('input',()=>output.textContent=el.value+'%');
        return element('label',{class:'slider-setting'},
          element('span',{},element('span',{text:label}),output),el);
      };
      const maxWidth=Math.max(300,Math.min(760,innerWidth-16)),maxHeight=Math.max(240,Math.min(2000,Math.floor(innerHeight*.9)));
      const check=(key,label)=> {const el=element('input',{type:'checkbox',checked:p[key]});controls[key]=el;return element('label',{class:'check'},el,element('span',{text:label}));};
      body.append(element('h3',{text:'外观'}),select('theme','主题',[['discord','跟随 Discord'],['dark','强制深色'],['light','强制浅色']]),
        element('div',{class:'row'},number('titleSize','标题字号（12–22 px）',12,22),number('uiSize','界面字号（11–18 px）',11,18)),
        select('lines','标题显示行数',[[1,'单行'],[2,'2 行'],[3,'3 行'],[4,'4 行'],[0,'完整显示']]),select('density','列表密度',[['compact','紧凑'],['standard','标准'],['relaxed','宽松']]),
        element('h3',{text:'布局'}),sizeSlider('width','面板宽度',300,maxWidth),sizeSlider('height','面板高度',240,maxHeight),
        select('dock','停靠位置',[['none','自由位置'],['left','左侧'],['right','右侧'],['top','顶部'],['bottom','底部']]),check('snap','拖动到距离边缘 24 px 内时吸附'),check('hover','悬停停靠标签时展开（默认关闭）'),check('autoOpen','进入已识别论坛时显示面板（保留手动折叠/隐藏）'),
        element('button',{text:'重置位置与尺寸',onclick:submit(async()=>{await this.resetLayout();controls.width.value=Math.round(100*(this.prefs.width-300)/Math.max(1,maxWidth-300));controls.height.value=Math.round(100*(this.prefs.height-240)/Math.max(1,maxHeight-240));controls.dock.value=this.prefs.dock;})}),
        element('h3',{text:'收藏与识别'}),select('defaultScope','新服务器默认筛选',[['forum','本频道'],['server','整个服务器']]),select('defaultSort','新服务器默认排序',SORTS.map((s,i)=>[s,['收藏时间 ↓','收藏时间 ↑','修改时间 ↓','修改时间 ↑','标题 A → Z','标题 Z → A','星标优先'][i]])),
        check('autoFollow','实验性：原生关注成功后记录本地收藏'),check('debug','控制台输出无标题、ID、链接的调试事件'),
        element('h3',{text:'关于'}),element('p',{class:'muted',text:'版本 '+VERSION+' · 使用当前页面可见信息识别帖子，原生关注同步为实验性功能。'}),
        element('button',{class:'primary',text:'保存设置',onclick:submit(async()=>{
          const patch={};for(const [key,el] of Object.entries(controls)) {
            if(el.type==='checkbox')patch[key]=el.checked;
            else if((key==='width'||key==='height')&&el.type==='range'){
              const low=key==='width'?300:240,high=key==='width'?maxWidth:maxHeight;
              patch[key]=Math.round(low+(high-low)*Number(el.value)/100);
            }
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
