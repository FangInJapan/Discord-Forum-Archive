import {canonical,ID,identity,parseLink} from './core.js';
// Only visible DOM and route information. No webpack stores, token access, or HTTP interception.
export const FOLLOW = /^(Follow(?: Post| Thread)?|Join(?: Thread| Post)?|关注(?:帖子|讨论串)?|關注(?:貼文|討論串)?|加入(?:帖子|讨论串|討論串)?|フォロー(?:する)?|参加(?:する)?)$/i;
export const UNFOLLOW = /^(Unfollow(?: Post| Thread)?|Following|Joined(?: Thread| Post)?|Leave(?: Thread| Post)?|取消关注(?:帖子)?|已关注|正在关注|取消關注(?:貼文)?|已關注|退出(?:帖子|讨论串|討論串)?|フォロー中|フォロー解除|フォローを解除|参加中|参加を取り消す|退出(?:する)?)$/i;
const CREATE = /^(New Post|Create Post|新建帖子|创建帖子|發佈貼文|建立貼文|新しい投稿|投稿を作成)$/i;
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
    this.menuTarget = null; this.contextMenu = e => this.handleContextMenu(e); this.click = this.handleClick.bind(this); this.scheduled = () => this.schedule();
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
    const scopes = [...this.doc.querySelectorAll('main header,main [role="toolbar"],[role="main"] header,[role="main"] [role="toolbar"],[role="dialog"] header,[role="dialog"] [role="toolbar"],[class*="threadSidebar"] header,[class*="threadSidebar"] [role="toolbar"]')];
    return [...new Set(scopes.flatMap(r=>[...r.querySelectorAll('button,[role="button"],[role="menuitem"]')]))]
      .filter(b=>visible(b) && !b.closest('article,[role="listitem"],[data-list-id="chat-messages"],[id^="chat-messages"]'));
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
    const isThread = !!(candidateId || known || captured || (follows.length && !root) || (this.menuTarget?.threadId === route.channelId));
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
    if (href !== this.lastHref) { this.followSerial++; this.pending = null; this.lastHref = href; }
    const c = this.inspect();
    if (c.type === 'forum') this.catalog.set(`${c.guildId}:${c.forumId}`,c);
    this.context = c;
    const sig = JSON.stringify(c);
    if (sig !== this.signature) { this.signature = sig; this.onContext(c); }
  }
  // Menu targets are tied to the current post or an explicit forum-card link.
  // Never infer a target from an unrelated menu or from the current forum ID.
  resolveTarget(button) {
    const c = this.inspect();
    if (c.type === 'thread') return c;
    const link = button.closest('a[href]') || button.closest('article,[role="listitem"]')?.querySelector('a[href*="/channels/"]');
    if (link) {
      try {
        const parsed = parseLink(link.href), forum = this.context;
        if (forum.type === 'forum' && parsed.guildId === forum.guildId && parsed.threadId !== forum.forumId)
          return {...forum,type:'thread',threadId:parsed.threadId,originalTitle:this.title(link) || link.textContent.trim(),url:parsed.url};
      } catch {}
    }
    if (this.menuTarget && Date.now() - this.menuTarget.at < 10000 && c.guildId === this.menuTarget.guildId)
      return this.menuTarget;
    return null;
  }
  followStatus(c) {
    if (!c || c.type !== 'thread') return false;
    const context = this.inspect();
    if (context.type !== 'thread' || identity(context) !== identity(c)) return false;
    return this.controls().some(el => !el.closest('[role="menu"]') && UNFOLLOW.test(controlLabel(el)));
  }
  handleContextMenu(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest('#dfa-root')) return;
    const c = this.resolveTarget(target);
    if (c?.type === 'thread') this.menuTarget = {...c,at:Date.now()};
  }
  visibleFollowingPosts() {
    const c = this.inspect(), root = this.forumRoot(this.main());
    if (c.type !== 'forum' || !root) return [];
    const results = new Map();
    for (const anchor of root.querySelectorAll('a[href*="/channels/"]')) {
      const card = anchor.closest('article,[role="listitem"],[data-thread-id]');
      if (!card || !visible(anchor)) continue;
      const status = [...card.querySelectorAll('button,[role="button"],[aria-label],[title]')]
        .some(el => visible(el) && UNFOLLOW.test(controlLabel(el)));
      if (!status) continue;
      try {
        const p = parseLink(anchor.href);
        if (p.guildId !== c.guildId || p.threadId === c.forumId) continue;
        results.set(identity(p), {...c,type:'thread',threadId:p.threadId,originalTitle:this.title(anchor) || anchor.textContent.trim(),url:p.url});
      } catch {}
    }
    return [...results.values()];
  }
  handleClick(event) {
    if (!event.isTrusted || event.composedPath().some(n => n?.id === 'dfa-root')) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;
    const anchor = target.closest('a[href]');
    if (anchor && this.context.type === 'forum' && this.forumRoot(this.main())?.contains(anchor)) {
      try {
        const p = parseLink(anchor.href), c = this.context;
        if (p.guildId === c.guildId && p.threadId !== c.forumId) {
          this.links.set(identity(p), {...c,threadId:p.threadId,originalTitle:this.title(anchor) || (anchor.getAttribute('aria-label') || anchor.textContent || '').trim()});
          if (this.links.size > 500) this.links.delete(this.links.keys().next().value);
        }
      } catch {}
    }
    const button = target.closest('button,[role="button"],[role="menuitem"]');
    if (!button || !this.isEnabled()) return;
    const label = controlLabel(button);
    if (!FOLLOW.test(label)) {
      // Preserve a verified target when opening the contextual menu on a forum card.
      if (button.getAttribute('aria-haspopup') === 'menu' || button.getAttribute('aria-expanded') === 'true') {
        const ctx = this.resolveTarget(button);
        if (ctx?.type === 'thread') this.menuTarget = {...ctx,at:Date.now()};
      }
      return;
    }
    const c = this.resolveTarget(button);
    if (!c || c.type !== 'thread') { this.log('native-follow-target-unknown'); return; }
    const serial = ++this.followSerial, href = this.href(), profile = this.isEnabled(), started = performance.now();
    this.pending = {serial};
    const check = () => {
      if (serial !== this.followSerial || profile !== this.isEnabled()) return;
      const current = this.inspect();
      // Menu clicks may close a menu or navigate, but cannot silently change the target.
      if (current.guildId !== c.guildId || (current.type === 'thread' && identity(current) !== identity(c))) return;
      const menu = [...this.doc.querySelectorAll('[role="menu"] [role="menuitem"],[role="menu"] button')].filter(visible);
      const inverse = this.followStatus(c) || (current.type === 'thread' && menu.some(el => UNFOLLOW.test(controlLabel(el))));
      if (inverse) {
        this.followTimer = setTimeout(() => {
          if (serial === this.followSerial && profile === this.isEnabled() && this.followStatus(c)) {
            this.pending = null; this.followSerial++; this.onFollow(this.inspect());
          }
        },650);
        return;
      }
      if (performance.now() - started < 8000) this.followTimer = setTimeout(check,220);
      else { this.pending = null; this.log('native-follow-unconfirmed'); }
    };
    this.followTimer = setTimeout(check,220);
  }
  start() {
    this.doc.addEventListener('click',this.click,true); this.doc.addEventListener('contextmenu',this.contextMenu,true);
    window.addEventListener('popstate',this.scheduled); window.addEventListener('hashchange',this.scheduled);
    this.observer = new MutationObserver(mutations=> {
      if (mutations.some(m=>m.target !== this.doc.getElementById('dfa-root') && !this.doc.getElementById('dfa-root')?.contains(m.target))) this.schedule();
    });
    this.observer.observe(this.doc.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','aria-pressed','data-thread-id']});
    // URL polling catches pushState/replaceState without patching Discord's History API.
    this.interval = setInterval(()=> { if (this.href() !== this.lastHref) this.scan(); },500);
    this.scan();
  }
  stop() {
    this.observer?.disconnect(); clearInterval(this.interval); clearTimeout(this.timer); clearTimeout(this.followTimer); this.followSerial++;
    this.doc.removeEventListener('click',this.click,true);this.doc.removeEventListener('contextmenu',this.contextMenu,true); window.removeEventListener('popstate',this.scheduled); window.removeEventListener('hashchange',this.scheduled);
  }
}
