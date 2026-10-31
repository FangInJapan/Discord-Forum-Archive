export const STYLE = `
:host{all:initial;color-scheme:dark;--bg:#242429;--card:#2e2e35;--fg:#f2f3f5;--muted:#bbbcc7;--line:#555560;--accent:#5865f2;--hover:#3b3b43;--on-accent:#fff;font-family:gg sans,Noto Sans,Helvetica Neue,Arial,sans-serif;font-size:var(--ui-size,13px);color:var(--fg);line-height:1.5}
*{box-sizing:border-box} [hidden]{display:none!important} button,input,select{font:inherit} button,a,input,select,summary{outline-offset:3px} :focus-visible{outline:2px solid var(--accent)}
button,select{border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);padding:6px 9px;cursor:pointer;min-height:30px} button:hover,summary:hover{background:var(--hover)} button:disabled{opacity:.5;cursor:wait} button.primary{background:var(--accent);color:var(--on-accent);border-color:transparent} button.danger{border-color:#d86b78;color:var(--fg)} a{color:var(--fg);text-decoration:none} input{min-width:0;width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px} input[type=checkbox]{width:auto;accent-color:var(--accent)} input[type=range]{padding:0} input[type=file]{font-size:12px} p{margin:8px 0} small,.muted{color:var(--muted);font-size:.9em} h2{font-size:1.2em;margin:0} h3{font-size:1em;margin:15px 0 7px} .row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.grow{flex:1;min-width:0}.stack{display:grid;gap:9px}.notice{padding:9px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.status{color:var(--muted)}
.panel{position:fixed;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:13px;box-shadow:0 12px 42px #0005;overflow:hidden;min-width:0;transition:box-shadow .12s}.panel.moving{box-shadow:0 16px 50px #0009;user-select:none}.header{display:flex;align-items:center;gap:5px;padding:11px 12px 8px;cursor:grab;touch-action:none;flex-shrink:0}.header strong{letter-spacing:.2px;flex:1;min-width:0}.icon{padding:3px 7px;min-width:30px;flex-shrink:0}.context{padding:0 13px 9px;overflow-wrap:anywhere;color:var(--muted);font-size:.9em}.tools{padding:0 12px 10px;display:grid;gap:7px;flex-shrink:0}.tools select{min-width:0;flex:1;width:30%}.profile{border:0;text-align:left;padding:0;background:none;color:var(--muted);font-size:.9em;min-height:25px}.list{overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:0;padding:2px 10px 10px;scrollbar-width:thin}.card{border:1px solid var(--line);border-radius:9px;padding:var(--spacing,10px);background:var(--card);margin:0 0 8px;content-visibility:auto;contain-intrinsic-size:auto 140px}.card-title{font-size:var(--title-size,15px);font-weight:600;line-height:1.45;overflow-wrap:anywhere;word-break:normal;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--title-lines,4);overflow:hidden}.card-title.full{display:block;overflow:visible;-webkit-line-clamp:unset}.card-title:hover{text-decoration:underline}.meta{font-size:.85em;color:var(--muted);overflow-wrap:anywhere;margin:6px 0}.actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.actions button{font-size:.85em;min-height:27px;padding:2px 7px}.star[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}.empty{padding:28px 10px;text-align:center;color:var(--muted)}.footer{padding:7px 12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.85em;color:var(--muted)}.footer button{font-size:inherit;padding:1px 6px;min-height:24px}.tab{position:fixed;width:40px;height:92px;padding:7px 4px;white-space:nowrap;writing-mode:vertical-rl;text-orientation:upright;letter-spacing:1px;border-radius:9px;box-shadow:0 4px 20px #0004;background:var(--bg);color:var(--fg)}.quick{position:fixed;right:16px;top:12px;max-width:min(300px,90vw);box-shadow:0 3px 15px #0005;background:var(--bg)}
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

@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}*::before,*::after{transition:none!important;animation:none!important}}`;
