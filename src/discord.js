import {canonical,ID,identity,parseLink} from './core.js';
// Only visible DOM and route information. No webpack stores, token access, or HTTP interception.
export const FOLLOW = /^(?:关注(?:帖子|讨论串|此帖)?|加入(?:帖子|讨论串)?|追踪(?:帖子)?)$/;
export const UNFOLLOW = /^(?:取消关注(?:帖子|此帖)?|停止关注|已关注|正在关注|退出(?:帖子|讨论串)?|取消加入|已加入|已追踪)$/;
const CREATE = /^(?:新建帖子|创建帖子|发布帖子|发表帖子|发起帖子)$/;
export function normalizeThreadTitle(value) {
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
export function visibleForumPostLink(href, context) {
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
export function controlLabel(el) { return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim(); }
export function visible(el) { return !!el && !el.closest('[hidden],[aria-hidden="true"]') && el.getClientRects().length > 0; }
export function routeOf(href) {
  try {
    const u = new URL(href); const m = u.pathname.match(/^\/channels\/(@me|\d{16,22})(?:\/(\d{16,22}))?/);
    if (!m || m[1] === '@me') return {type:'dm',guildId:null,channelId:null};
    return {type:'unknown',guildId:m[1],channelId:m[2] || null};
  } catch { return {type:'unknown',guildId:null,channelId:null}; }
}
export class DiscordAdapter {
  constructor(doc, onContext, onFollow, isEnabled, log, href = ()=>location.href) {
    this.doc = doc; this.onContext = onContext; this.onFollow = onFollow; this.isEnabled = isEnabled; this.log = log;
    this.context = {type:'unknown'}; this.links = new Map(); this.catalog = new Map(); this.knownThreads = new Map();
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
      const heading=card?.querySelector('h2,h3,h4,[role="heading"],[data-testid*="post-title"],[class*="postTitle"],[class*="threadTitle"],[class*="titleText"]');
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
    const root=this.forumRoot(this.main());
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
