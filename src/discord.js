import {canonical,ID,identity,parseLink} from './core.js';
// Only visible DOM and route information. No webpack stores, token access, or HTTP interception.
export const FOLLOW = /^(Follow(?: Post)?|Join(?: Thread| Post)?|关注(?:帖子)?|關注(?:貼文)?|加入(?:帖子|讨论串|討論串)?|フォロー(?:する)?|参加(?:する)?)$/i;
export const UNFOLLOW = /^(Unfollow(?: Post)?|Leave(?: Thread| Post)?|取消关注(?:帖子)?|取消關注(?:貼文)?|退出(?:帖子|讨论串|討論串)?|フォロー解除|フォローを解除|参加を取り消す|退出(?:する)?)$/i;
const CREATE = /^(New Post|Create Post|新建帖子|创建帖子|發佈貼文|建立貼文|新しい投稿|投稿を作成)$/i;
export function controlLabel(el) { return (el.getAttribute('aria-label') || el.textContent || '').trim(); }
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
    this.click = this.handleClick.bind(this); this.scheduled = () => this.schedule();
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
    const isThread = !!(candidateId || known || captured || (follows.length && !root));
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
          // Bound transient observations. Nothing is fetched or bulk-saved.
          if (this.links.size > 500) this.links.delete(this.links.keys().next().value);
        }
      } catch { /* a message/user/other link is not a post candidate */ }
    }
    const button = target.closest('button,[role="button"],[role="menuitem"]');
    if (!button || !this.isEnabled() || !FOLLOW.test(controlLabel(button))) return;
    const c = this.inspect();
    // Context-menu target cannot be tied reliably to the open post: deliberately ignore it.
    if (c.type !== 'thread' || button.closest('[role="menu"]') || !this.controls().includes(button)) return;
    const serial = ++this.followSerial, href = this.href(), profile = this.isEnabled();
    const started = performance.now(); this.pending = {serial};
    const check = () => {
      if (serial !== this.followSerial || href !== this.href() || profile !== this.isEnabled()) return;
      const current = this.inspect();
      if (current.type !== 'thread' || identity(current) !== identity(c)) return;
      // Require an inverse action on the same connected control, stable for 650 ms.
      // Replacement controls cannot be tied reliably to the original; manual save remains available.
      if (button.isConnected && visible(button) && !button.disabled && UNFOLLOW.test(controlLabel(button))) {
        setTimeout(()=> {
          if (serial === this.followSerial && href === this.href() && profile === this.isEnabled() && button.isConnected &&
            visible(button) && !button.disabled && UNFOLLOW.test(controlLabel(button)) && identity(this.inspect()) === identity(c)) {
            this.pending = null; this.followSerial++; this.onFollow(current);
          }
        },650); return;
      }
      if (performance.now()-started < 8000) this.followTimer = setTimeout(check,220);
      else { this.pending = null; this.log('native-follow-unconfirmed'); }
    };
    this.followTimer = setTimeout(check,220);
  }
  start() {
    this.doc.addEventListener('click',this.click,true);
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
    this.doc.removeEventListener('click',this.click,true); window.removeEventListener('popstate',this.scheduled); window.removeEventListener('hashchange',this.scheduled);
  }
}
