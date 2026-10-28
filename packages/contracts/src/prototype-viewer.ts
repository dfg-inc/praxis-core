import { esc, pill } from "./review-util.js";
import type { Prototype, PrototypeElement, PrototypeScreen } from "./planning-schemas.js";
import type { WorkflowState } from "./workflow.js";

/**
 * Prototype Viewer: a small interactive engine that runs a stored prototype on its own mock data, inside the review page.
 * The prototype is DATA (screens, elements, mock rows, scenarios). The engine builds DOM with textContent only, never
 * evaluates anything from the prototype, never talks to the network, and keeps its working copy of the mock data in memory.
 * The address bar is virtual: query parameters live in the page's #hash, so deep links and Back/Forward work without a server.
 */

const COLOR_OK = /^[#\w(),.%\s/-]{1,60}$/;
/** A token value must be a colour or a length: nothing that can fetch a resource (url(), image-set(), src()) or escape the declaration. */
const safeToken = (v: string) => COLOR_OK.test(v) && !/url|image|src|expression|element|paint|cross-fade|attr|var\(/i.test(v);
const FONT_OK = /^[\w\s,'"-]{1,80}$/;

/** Black or white, whichever reads better on a #rrggbb colour. Anything else gets white. */
function onColor(hex: string | undefined): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "") ?? /^#([0-9a-f]{3})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "#111" : "#fff";
}

export function prototypeVars(proto: Prototype): string {
  const colors = proto.styles.colors;
  const out = [
    ...Object.entries(colors).filter(([, v]) => safeToken(v)).map(([k, v]) => `--p-${k.replace(/[^\w-]/g, "")}:${v}`),
    ...(proto.styles.fonts.body && FONT_OK.test(proto.styles.fonts.body) && !/url|image|src/i.test(proto.styles.fonts.body) ? [`--p-font:${proto.styles.fonts.body}`] : []),
    ...(proto.styles.fonts.heading && FONT_OK.test(proto.styles.fonts.heading) && !/url|image|src/i.test(proto.styles.fonts.heading) ? [`--p-font-heading:${proto.styles.fonts.heading}`] : []),
    ...(proto.styles.radius && safeToken(proto.styles.radius) ? [`--p-radius:${proto.styles.radius}`] : []),
    ...(proto.styles.spacing && safeToken(proto.styles.spacing) ? [`--p-space:${proto.styles.spacing}`] : []),
    `--p-on-primary:${onColor(colors.primary)}`,
  ];
  return out.join(";");
}

export const PROTOTYPE_CSS = `
main.wide{max-width:1360px}
.pv-head{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 10px}
.pv-bar{display:flex;gap:10px 14px;flex-wrap:wrap;align-items:flex-end;margin:0 0 12px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.pv-bar label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--muted)}.pv-bar select{width:auto;min-width:120px;padding:3px 6px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
.seg button{border:0;border-radius:0;background:transparent;padding:5px 12px;font-size:13px}
.seg button+button{border-left:1px solid var(--line)}.seg button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
.pv-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
@media (max-width:1000px){.pv-grid{grid-template-columns:minmax(0,1fr)}}
.pv-side{border:1px solid var(--line);border-radius:10px;background:var(--card);position:sticky;top:8px;max-height:calc(100vh - 90px);overflow:auto}
@media (max-width:1000px){.pv-side{position:static;max-height:none}}
.pv-tabs{display:flex;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1}
.pv-tabs button{flex:1;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:9px 6px;font-size:13px}
.pv-tabs button[aria-selected=true]{border-bottom-color:var(--accent);font-weight:600}
.pv-panel{padding:10px 12px}.pv-panel[hidden]{display:none}
.pv-panel h3{margin:10px 0 4px}.pv-panel ul{margin:4px 0;padding-left:18px}
.pv-device{margin:0 auto;max-width:100%}.pv-device.mobile{max-width:390px}
.pv-addr{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-bottom:0;border-radius:10px 10px 0 0;padding:6px 10px;background:var(--card);font-size:12px;color:var(--muted)}
.pv-addr input{flex:1;font:12px ui-monospace,Menlo,monospace;padding:3px 6px}
.proto{--pc-bg:var(--p-background,#fff);--pc-text:var(--p-text,#1d2330);--pc-primary:var(--p-primary,#2457d6);--pc-on-primary:var(--p-on-primary,#fff);--pc-danger:var(--p-danger,#b42318);--pc-success:var(--p-success,#17803d);--pc-warning:var(--p-warning,#a15c00);
--pc-surface:var(--p-surface,color-mix(in srgb,var(--pc-text) 4%,var(--pc-bg)));--pc-border:var(--p-border,color-mix(in srgb,var(--pc-text) 16%,var(--pc-bg)));--pc-muted:color-mix(in srgb,var(--pc-text) 62%,var(--pc-bg));
--pc-r:var(--p-radius,8px);--pc-s:var(--p-space,8px);
container-type:inline-size;container-name:proto;border:1px solid var(--line);border-radius:0 0 10px 10px;overflow:hidden;background:var(--pc-bg);color:var(--pc-text);font:14px/1.45 var(--p-font,system-ui,-apple-system,"Segoe UI",sans-serif)}
.proto .nav{display:flex;gap:calc(var(--pc-s)*.5);padding:var(--pc-s);border-bottom:1px solid var(--pc-border);background:var(--pc-surface);overflow-x:auto}
.proto .nav button{white-space:nowrap;background:transparent;color:var(--pc-text);border:1px solid transparent;border-radius:var(--pc-r);padding:4px 10px;font:inherit}
.proto .nav button.on{background:var(--pc-primary);color:var(--pc-on-primary)}
.proto .screen{position:relative;min-height:440px;padding:calc(var(--pc-s)*2.5);overflow:hidden;outline:0}
.proto h2{font-weight:600;font-size:20px;line-height:1.25;font-family:var(--p-font-heading,var(--p-font,system-ui,-apple-system,sans-serif));margin:0 0 var(--pc-s)}.proto h3{font-weight:600;font-size:15px;line-height:1.3;font-family:var(--p-font-heading,var(--p-font,system-ui,-apple-system,sans-serif));margin:0}
.proto .lead{color:var(--pc-muted);margin:0 0 calc(var(--pc-s)*2)}
.proto .el{position:relative;margin:calc(var(--pc-s)*1.5) 0;border-radius:var(--pc-r)}
.proto .row-el{display:flex;gap:var(--pc-s);align-items:flex-end;flex-wrap:wrap}
.proto label.lab{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--pc-muted)}
.proto input,.proto select{font:inherit;color:var(--pc-text);background:var(--pc-bg);border:1px solid var(--pc-border);border-radius:var(--pc-r);padding:6px 10px;min-width:160px;width:auto}
.proto input:focus-visible,.proto select:focus-visible,.proto button:focus-visible,.proto tr:focus-visible,.proto [tabindex]:focus-visible{outline:2px solid var(--pc-primary);outline-offset:2px}
.proto .btn{background:var(--pc-primary);color:var(--pc-on-primary);border:1px solid var(--pc-primary);border-radius:var(--pc-r);padding:6px 14px;font:inherit;font-weight:600;cursor:pointer}
.proto .btn.sec{background:transparent;color:var(--pc-primary)}.proto .btn.danger{background:var(--pc-danger);border-color:var(--pc-danger)}
.proto table{border-collapse:collapse;width:100%}.proto th{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--pc-muted);text-align:left;padding:8px 12px;border-bottom:1px solid var(--pc-border);background:var(--pc-surface)}
.proto td{padding:9px 12px;border-bottom:1px solid var(--pc-border)}
.proto .tblwrap{border:1px solid var(--pc-border);border-radius:var(--pc-r);overflow:auto}.proto .tblwrap tr:last-child td{border-bottom:0}
.proto tr[data-row]{cursor:pointer}.proto tr[data-row]:hover td{background:var(--pc-surface)}.proto tr[data-row][aria-selected=true] td{background:color-mix(in srgb,var(--pc-primary) 12%,var(--pc-bg))}
.proto .count{font-size:12px;color:var(--pc-muted);margin:4px 2px}
.proto .miss{color:var(--pc-muted);font-style:italic}
.proto .badge{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;border:1px solid var(--pc-border);background:var(--pc-surface)}
.proto .badge.info{color:var(--pc-primary);border-color:var(--pc-primary)}.proto .badge.ok{color:var(--pc-success);border-color:var(--pc-success)}.proto .badge.warn{color:var(--pc-warning);border-color:var(--pc-warning)}.proto .badge.bad{color:var(--pc-danger);border-color:var(--pc-danger)}
.proto .state-msg{padding:calc(var(--pc-s)*3);text-align:center;color:var(--pc-muted);border:1px dashed var(--pc-border);border-radius:var(--pc-r)}
.proto .state-msg.error{color:var(--pc-danger);border-color:var(--pc-danger)}.proto .state-msg.loading{animation:pvpulse 1.2s ease-in-out infinite}
@keyframes pvpulse{50%{opacity:.5}}
.proto .msg{padding:var(--pc-s) calc(var(--pc-s)*1.5);border-radius:var(--pc-r);border:1px solid var(--pc-border);background:var(--pc-surface)}
.proto .msg.ok{border-color:var(--pc-success)}.proto .err{color:var(--pc-danger);font-size:12px}
.proto .denied{padding:var(--pc-s);border:1px dashed var(--pc-danger);color:var(--pc-danger);border-radius:var(--pc-r)}
.proto .tabs{display:flex;gap:2px;border-bottom:1px solid var(--pc-border)}
.proto .tabs button{background:transparent;border:0;border-bottom:3px solid transparent;border-radius:0;color:var(--pc-muted);padding:8px 14px;font:inherit;cursor:pointer}
.proto .tabs button[aria-selected=true]{color:var(--pc-text);border-bottom-color:var(--pc-primary);font-weight:600}
.proto .screen.with-drawer{padding-right:calc(380px + var(--pc-s)*2.5)}
.proto .pv-overlay{position:absolute;top:0;right:0;bottom:0;width:min(380px,100%);background:var(--pc-bg);border-left:1px solid var(--pc-border);box-shadow:-8px 0 24px rgba(0,0,0,.12);display:flex;flex-direction:column;z-index:3;outline:0}
.proto .pv-overlay.modal{top:50%;right:auto;bottom:auto;left:50%;transform:translate(-50%,-50%);width:min(440px,92%);max-height:90%;border:1px solid var(--pc-border);border-radius:var(--pc-r)}
.proto .pv-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35);z-index:2}
.proto .pv-overlay header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:calc(var(--pc-s)*1.5) calc(var(--pc-s)*2);border-bottom:1px solid var(--pc-border)}
.proto .pv-overlay .x{background:transparent;border:0;font-size:22px;line-height:1;color:var(--pc-muted);cursor:pointer;padding:2px 8px;border-radius:var(--pc-r)}
.proto .pv-overlay .body{padding:calc(var(--pc-s)*2);overflow:auto}
.proto dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 16px;margin:0}.proto dt{color:var(--pc-muted);font-size:12px;font-weight:600;padding-top:2px}.proto dd{margin:0}
@container proto (max-width:760px){.proto .screen.with-drawer{padding-right:calc(var(--pc-s)*1.5);min-height:640px}}
@container proto (max-width:620px){.proto .screen{padding:calc(var(--pc-s)*1.5)}.proto .pv-overlay{width:100%;border-left:0}.proto input,.proto select{min-width:0;width:100%}.proto .row-el>*{flex:1 1 100%}.proto th,.proto td{padding:8px}.proto dl{grid-template-columns:1fr}}
.proto[data-mode=inspect] .screen *,.proto[data-mode=review] .screen *{pointer-events:none}
.proto[data-mode=inspect] .screen [data-el],.proto[data-mode=review] .screen [data-el]{pointer-events:auto;cursor:crosshair}
.proto[data-mode=inspect] .screen [data-el]:hover,.proto[data-mode=review] .screen [data-el]:hover{outline:2px dashed var(--pc-primary);outline-offset:2px}
.proto .screen [data-el].sel{outline:2px solid var(--pc-primary);outline-offset:2px}
.proto[data-mode=inspect] .screen [data-el]:hover::after,.proto[data-mode=inspect] .screen [data-el].sel::after,.proto[data-mode=review] .screen [data-el].sel::after{content:attr(data-tag);position:absolute;top:-10px;right:4px;font-size:11px;padding:0 6px;border-radius:4px;background:var(--pc-primary);color:var(--pc-on-primary);pointer-events:none;z-index:5}
.proto .pv-cbtn{display:none}.proto[data-mode=review] .pv-cbtn{display:inline-block;pointer-events:auto;position:absolute;top:-10px;left:4px;font-size:11px;padding:0 6px;background:var(--pc-surface);color:var(--pc-text);border:1px solid var(--pc-border);border-radius:4px;cursor:pointer;z-index:5}
.pv-side .sc{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;margin:4px 0;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.pv-side .sc .dot{flex:none;width:18px;text-align:center;font-weight:700}.pv-side .sc .dot.ok{color:var(--ok)}.pv-side .sc .dot.bad{color:var(--bad)}
.pv-side .sc.cur{border-color:var(--accent)}.pv-side .sc small{display:block;color:var(--muted)}
.pv-side .fail{color:var(--bad);font-size:12px;margin:2px 0 0 26px}
.fbcard{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:8px;margin:8px 0}.fbcard textarea{margin-top:4px}
.fbcard .top{display:flex;justify-content:space-between;gap:6px}
details.pv-cov,details.pv-about{margin:14px 0;border:1px solid var(--line);border-radius:10px;background:var(--card)}
details.pv-cov>summary,details.pv-about>summary{cursor:pointer;padding:10px 14px;font-weight:600}
details.pv-cov .covbody,details.pv-about .covbody{padding:0 14px 12px}
.cov-req{border-top:1px solid var(--line);padding:8px 0}.cov-req>summary{cursor:pointer}.cov-req ul{margin:4px 0;padding-left:20px;font-size:13px}
.cov-req .gt{border:0;background:none;color:var(--accent);padding:0;text-decoration:underline;font-size:13px}
`;

export const PROTOTYPE_SCRIPT = String.raw`
// prototype viewer
if(D.view==='prototype'&&D.proto&&D.proto.kind==='ui'){(function(){
var P=D.proto;P.datasets=P.datasets||[];P.scenarios=P.scenarios||[];P.screens=P.screens||[];P.mock=P.mock||[];
var host=$('#proto-screen'),frame=$('#proto-frame'),urlIn=$('#proto-url'),device=$('#pv-device');
var startId=P.startScreen||(P.screens[0]&&P.screens[0].id);
var live={},search={},form={},formErr={},dsId='',role0=(P.roles&&P.roles[0])||'',role=role0,stateName='default',mode='preview',sel=null,cur=startId,q={},opened={},opener=null,results={},curScenario=null;
function by(attr,val,root){return $$('['+attr+']',root||document).filter(function(e){return e.getAttribute(attr)===val})[0]||null}
function clone(x){return JSON.parse(JSON.stringify(x))}
function h(t,a,c){var e=document.createElement(t);for(var k in (a||{})){if(a[k]===null||a[k]===undefined)continue;if(k==='class')e.className=a[k];else e.setAttribute(k,a[k])}(c||[]).forEach(function(x){if(x===null||x===undefined)return;e.appendChild(typeof x==='string'?document.createTextNode(x):x)});return e}
function T(s){return document.createTextNode(s)}
function collDef(id){return P.mock.filter(function(c){return c.id===id})[0]}
function fieldDef(cid,key){var c=collDef(cid);return c?c.fields.filter(function(f){return f.key===key})[0]:undefined}
function screenById(id){return P.screens.filter(function(s){return s.id===id})[0]}
function loadData(){live={};P.mock.forEach(function(c){live[c.id]=clone(c.rows)});var ds=P.datasets.filter(function(d){return d.id===dsId})[0];if(ds)Object.keys(ds.rows).forEach(function(k){live[k]=clone(ds.rows[k])})}
loadData();
// ---- virtual address: /screen?param=value, kept in the page #hash
function dec(x){try{return decodeURIComponent(x.replace(/\+/g,' '))}catch(e){return x}}
function parseUrl(s){s=String(s||'').replace(/^#/,'').trim();var i=s.indexOf('?');var path=(i>=0?s.slice(0,i):s).replace(/^\/+/,'').replace(/\/+$/,'');var out={};(i>=0?s.slice(i+1):'').split('&').forEach(function(p){if(!p)return;var j=p.indexOf('=');var k=dec(j>=0?p.slice(0,j):p);var v=j>=0?dec(p.slice(j+1)):'';if(k&&Object.keys(out).length<20)out[k.slice(0,60)]=v.slice(0,200)});return {screen:path,query:out}}
function buildUrl(screen,query){var parts=Object.keys(query).filter(function(k){return query[k]!==''&&query[k]!==undefined}).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(query[k])});return '/'+(screen||'')+(parts.length?'?'+parts.join('&'):'')}
function fromUrl(u){if(!u.screen){cur=startId}else cur=u.screen;q=u.query}
var quiet=false;
function pushUrl(replace){var url='#'+buildUrl(cur,q);if(!replace&&!quiet&&url===location.hash)return;try{if(replace||quiet)history.replaceState(null,'',url);else history.pushState(null,'',url)}catch(e){}}
function go(screen,query,replace){cur=screen;q=query||{};pushUrl(replace);render()}
function setParam(name,value,replace){var n=clone(q);if(value===''||value===undefined||value===null)delete n[name];else n[name]=value;q=n;pushUrl(replace);render()}
function defaults(scr){var d={};(scr?scr.elements:[]).forEach(function(e){if(e.kind==='tabs'&&e.tabs&&e.tabs.length)d[e.param||'tab']=e.tabs[0].id});return d}
function pv(name,scr){if(q[name]!==undefined&&q[name]!=='')return q[name];var d=defaults(scr||screenById(cur));return d[name]||''}
function shown(el,scr){var w=el.showWhen;if(!w)return true;var v=pv(w.param,scr);if(w.equals!==undefined&&v!==w.equals)return false;if(w.notEquals!==undefined&&v===w.notEquals)return false;if(w.present!==undefined&&(v!=='')!==w.present)return false;return true}
// ---- data helpers
function idField(el){if(el.idField)return el.idField;var c=collDef(el.collection);if(c&&c.fields.some(function(f){return f.key==='id'}))return 'id';return (el.columns&&el.columns[0])||(c&&c.fields[0]&&c.fields[0].key)||'id'}
function knownValues(coll,field){var f=fieldDef(coll,field);if(f&&f.options&&f.options.length)return f.options;var seen={};(live[coll]||[]).forEach(function(r){if(r[field]!==null&&r[field]!==undefined)seen[String(r[field])]=1});return Object.keys(seen)}
function ignored(f,coll,v){return f.unknown==='all'&&v!==''&&knownValues(coll,f.field).indexOf(v)<0}
function unknownAll(param,scr){var hit=false;(scr?scr.elements:[]).forEach(function(e){(e.filters||[]).forEach(function(f){if(f.param===param&&f.unknown==='all')hit=true})});return hit}
function rowsFor(el){var all=live[el.collection]||[];var out=all.filter(function(r){return (el.filters||[]).every(function(f){var v=pv(f.param);return v===''||ignored(f,el.collection,v)||String(r[f.field])===v})});var sq=search[el.collection];if(sq)out=out.filter(function(r){return JSON.stringify(r).toLowerCase().indexOf(sq.toLowerCase())>=0});return out}
function fmt(v,f){if(typeof v==='boolean')return v?'Yes':'No';return String(v)}
function tone(v){var t=String(v).toLowerCase();return /cancel|reject|fail|error|declin|denied|block/.test(t)?'bad':/deliver|done|complete|paid|active|approv|success|resolved|closed/.test(t)?'ok':/progress|pending|wait|review|hold|process/.test(t)?'warn':/new|open|draft|created/.test(t)?'info':''}
function badge(v,f){var i=f&&f.options?f.options.indexOf(String(v)):-1;return h('span',{class:'badge '+(i<0?'':tone(v)),'data-v':String(v),title:i<0&&f&&f.options?'Value not in the known list':null},[String(v)])}
function valueNode(f,v,el,table){if(v===null||v===undefined||v===''){return h('span',{class:'miss'},[el.missingText||(table?'—':'Not provided')])}if(f&&f.type==='enum')return badge(v,f);return T(fmt(v,f))}
function emptyMsg(text){return h('div',{class:'state-msg','data-empty':'1'},[text])}
// ---- element renderers
function renderTable(scr,el){
  var box=h('div',{});var c=collDef(el.collection);
  if(!c){box.appendChild(emptyMsg('No data'));return box}
  var cols=el.columns&&el.columns.length?el.columns:c.fields.map(function(f){return f.key});
  var rows=rowsFor(el),id=idField(el),target=el.rowOpens&&scr.elements.filter(function(x){return x.id===el.rowOpens})[0],openId=target&&target.param?q[target.param]:undefined;
  if(!rows.length){var em=emptyMsg((el.emptyText||'No rows').replace(/\{(\w[\w-]*)\}/g,function(m,p){return pv(p,scr)}));if(el.emptyAction){var ab=h('button',{type:'button',class:'btn sec',style:'margin-top:8px','data-fk':'empty-action:'+scr.id+'#'+el.id},[el.emptyAction.label]);ab.addEventListener('click',function(){if(mode!=='preview')return;var n=clone(q);(el.emptyAction.clear||[]).forEach(function(k){delete n[k]});q=n;pushUrl(false);render()});em.appendChild(h('div',{},[ab]))}box.appendChild(em);box.appendChild(h('div',{class:'count','data-count':'0'},['0 of '+(live[el.collection]||[]).length]));return box}
  var t=h('table',{},[]);t.appendChild(h('thead',{},[h('tr',{},cols.map(function(k){var f=fieldDef(el.collection,k);return h('th',{scope:'col'},[f?f.label:k])}))]));
  var tb=h('tbody',{});
  rows.forEach(function(r){
    var rid=String(r[id]===undefined||r[id]===null?'':r[id]);
    var tr=h('tr',{'data-row':rid},cols.map(function(k){return h('td',{},[valueNode(fieldDef(el.collection,k),r[k],el,true)])}));
    if(target&&target.param){
      tr.setAttribute('tabindex','0');tr.setAttribute('aria-selected',String(openId===rid));tr.setAttribute('data-fk','row:'+scr.id+'#'+el.id+':'+rid);
      var open=function(){if(mode!=='preview')return;opener={fk:tr.getAttribute('data-fk')};setParam(target.param,rid)};
      tr.addEventListener('click',open);
      tr.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}});
    }
    tb.appendChild(tr)
  });
  t.appendChild(tb);box.appendChild(h('div',{class:'tblwrap'},[t]));
  box.appendChild(h('div',{class:'count','data-count':String(rows.length)},['Showing '+rows.length+' of '+(live[el.collection]||[]).length]));
  return box
}
function renderFilter(scr,el){
  var c=collDef(el.collection),f=c&&el.filters&&el.filters[0]?fieldDef(el.collection,el.filters[0].field):null;
  var opts=(el.options&&el.options.length?el.options:((f&&f.options)||[]).map(function(o){return {value:o}}));
  var sel=h('select',{'data-filter':el.param,'data-fk':'filter:'+el.param,'aria-label':el.label||el.param});
  sel.appendChild(h('option',{value:''},[el.allLabel||'All']));
  var cur=q[el.param]||'',known=false;
  opts.forEach(function(o){var op=h('option',{value:o.value},[o.label||o.value]);if(o.value===cur){op.selected=true;known=true}sel.appendChild(op)});
  if(cur&&!known&&!unknownAll(el.param,scr)){var bad=h('option',{value:cur},['Unknown: '+cur]);bad.selected=true;sel.appendChild(bad)}
  sel.addEventListener('change',function(){if(mode!=='preview')return;setParam(el.param,sel.value)});
  return h('label',{class:'lab'},[el.label||'Filter',sel])
}
function renderTabs(scr,el){
  var param=el.param||'tab',val=pv(param,scr);var bar=h('div',{class:'tabs',role:'tablist','aria-label':el.label||'Tabs'});
  el.tabs.forEach(function(t,i){
    var b=h('button',{type:'button',role:'tab','aria-selected':String(t.id===val),tabindex:t.id===val?'0':'-1','data-tab':t.id,'data-fk':'tab:'+param+':'+t.id},[t.label]);
    b.addEventListener('click',function(){if(mode!=='preview')return;setParam(param,t.id)});
    b.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d||mode!=='preview')return;e.preventDefault();var n=el.tabs[(i+d+el.tabs.length)%el.tabs.length];want='tab:'+param+':'+n.id;setParam(param,n.id)});
    bar.appendChild(b)});
  return bar
}
function renderField(scr,el){
  var key=scr.id+'#'+el.id,fd=el.collection&&el.field?fieldDef(el.collection,el.field):null,ctl;
  if(fd&&fd.type==='enum'){ctl=h('select',{});ctl.appendChild(h('option',{value:''},['Select...']));(fd.options||[]).forEach(function(o){ctl.appendChild(h('option',{value:o},[o]))})}
  else if(fd&&fd.type==='boolean')ctl=h('input',{type:'checkbox'});
  else ctl=h('input',{type:fd&&fd.type==='number'?'number':fd&&fd.type==='date'?'date':'text',placeholder:el.text||''});
  ctl.setAttribute('data-fk','field:'+key);if(el.required)ctl.setAttribute('aria-required','true');if(formErr[key])ctl.setAttribute('aria-invalid','true');
  if(form[key]!==undefined){if(ctl.type==='checkbox')ctl.checked=!!form[key];else ctl.value=form[key]}
  var upd=function(){form[key]=ctl.type==='checkbox'?ctl.checked:ctl.value;if(formErr[key]&&form[key]!==''){delete formErr[key];render()}};
  ctl.addEventListener('input',upd);ctl.addEventListener('change',upd);
  return h('label',{class:'lab'},[(el.label||el.field||'')+(el.required?' *':''),ctl,formErr[key]?h('span',{class:'err',role:'alert'},['Required']):null])
}
function renderButton(scr,el){
  var b=h('button',{class:'btn'+(el.kind==='link'?' sec':''),type:'button','data-fk':'btn:'+scr.id+'#'+el.id},[el.label||'Button']);
  b.addEventListener('click',function(e){e.stopPropagation();if(mode!=='preview')return;
    var c=el.collection&&collDef(el.collection);
    if(el.navigatesTo){stateName='default';go(el.navigatesTo,{})}
    else if(el.action==='add-row'&&c){var row={};c.fields.forEach(function(f){row[f.key]=f.type==='number'?live[c.id].length+1:f.type==='boolean'?false:f.type==='enum'&&f.options&&f.options[0]?f.options[0]:'New '+f.label});live[c.id].push(row);render()}
    else if(el.action==='delete-row'&&c){live[c.id].pop();render()}
    else if(el.action==='open-modal'&&el.rowOpens){var t=scr.elements.filter(function(x){return x.id===el.rowOpens})[0];if(t&&t.param){opener={fk:b.getAttribute('data-fk')};setParam(t.param,'1')}}
    else if(el.action==='close-modal'&&el.rowOpens){var t2=scr.elements.filter(function(x){return x.id===el.rowOpens})[0];if(t2&&t2.param)setParam(t2.param,'')}
    else if(el.action==='submit'){
      var bad=false;scr.elements.forEach(function(x){if(x.kind==='field'&&x.required){var k=scr.id+'#'+x.id;var v=form[k];if(v===undefined||v===''||v===false){formErr[k]=true;bad=true}}});
      if(bad){render();return}
      if(scr.states.indexOf('success')>=0){stateName='success'}else{form._ok=scr.id}
      render()}
  });
  return b
}
function recordFor(scr,el,val){var tbl=el.withinTable&&scr.elements.filter(function(x){return x.id===el.withinTable})[0];var rows=tbl?rowsFor(tbl):(live[el.collection]||[]);var id=el.idField||(tbl?idField(tbl):idField(el));return rows.filter(function(r){return String(r[id])===val})[0]}
function normalize(scr){var changed=false;(scr?scr.elements:[]).forEach(function(el){if((el.kind==='drawer'||el.kind==='modal')&&el.param&&el.onMissing==='close'&&q[el.param]!==undefined&&q[el.param]!==''&&!recordFor(scr,el,q[el.param])){var n=clone(q);delete n[el.param];q=n;changed=true}});if(changed)pushUrl(true)}
function renderOverlay(scr,el){
  var param=el.param;if(!param||q[param]===undefined||q[param]==='')return null;
  var key=scr.id+'#'+el.id,val=q[param],modal=el.kind==='modal',rec=null,state='open';
  if(el.collection&&el.detailFields&&el.detailFields.length){
    rec=recordFor(scr,el,val);if(!rec)state='not-found'}
  var title='ov-'+key.replace(/[^\w]/g,'-');
  var body=h('div',{class:'body'});
  if(state==='not-found'){body.appendChild(h('div',{class:'msg err',role:'alert','data-notfound':'1'},[(el.notFoundText||'This record was not found.')+' ('+param+'='+val+')']))}
  else if(rec){var dl=h('dl',{});(el.related||[]).forEach(function(){});el.detailFields.forEach(function(d){var f=fieldDef(el.collection,d.field);dl.appendChild(h('dt',{},[d.label||(f&&f.label)||d.field]));dl.appendChild(h('dd',{'data-field':d.field},[valueNode(f,rec[d.field],el,false)]))});body.appendChild(dl);(el.related||[]).forEach(function(rel){var rid=String(rec[idField(el)]),rows=(live[rel.collection]||[]).filter(function(r){return String(r[rel.matchField])===rid}),cols=rel.columns&&rel.columns.length?rel.columns:(collDef(rel.collection)?collDef(rel.collection).fields.map(function(f){return f.key}):[]);body.appendChild(h('h3',{style:'margin:16px 0 6px'},[rel.label||rel.collection]));if(!rows.length){body.appendChild(h('p',{class:'miss','data-related-empty':'1'},[el.missingText||'Not provided']));return}var t=h('table',{},[h('thead',{},[h('tr',{},cols.map(function(k){var f=fieldDef(rel.collection,k);return h('th',{scope:'col'},[f?f.label:k])}))]),h('tbody',{},rows.map(function(r){return h('tr',{},cols.map(function(k){return h('td',{},[valueNode(fieldDef(rel.collection,k),r[k],el,true)])}))}))]);body.appendChild(h('div',{class:'tblwrap'},[t]))})}
  else if(el.text||el.label){body.appendChild(h('p',{},[el.text||'']))}
  var x=h('button',{class:'x',type:'button','aria-label':'Close','data-fk':'close:'+key},['×']);
  x.addEventListener('click',function(){if(mode!=='preview')return;setParam(param,'')});
  var box=h('aside',{class:'pv-overlay '+(modal?'modal':'drawer'),role:'dialog','aria-modal':modal?'true':'false','aria-labelledby':title,tabindex:'-1','data-overlay':key,'data-state':state,'data-el':key,'data-tag':'','data-fk':'overlay:'+key},[h('header',{},[h('h3',{id:title},[el.label||'Details']),x]),body]);
  box.setAttribute('data-tag',(el.requirementIds||[]).concat(el.acIds||[]).join(' '));
  return {node:box,modal:modal,key:key,param:param}
}
function stateText(scr,s){return (scr.stateMessages&&scr.stateMessages[s])||({loading:'Loading...',empty:'Nothing here yet.',error:'Something went wrong.',success:'Done.',denied:'You do not have permission.'}[s]||s)}
function renderEl(scr,el){
  var k=el.kind,node=null;
  if(k==='heading')node=h('h3',{},[el.label||el.text||'']);
  else if(k==='text')node=h('p',{style:'margin:0'},[el.text||el.label||'']);
  else if(k==='table'||k==='list')node=renderTable(scr,el);
  else if(k==='filter'&&el.param)node=renderFilter(scr,el);
  else if(k==='tabs'&&el.tabs&&el.tabs.length)node=renderTabs(scr,el);
  else if(k==='search'){var i=h('input',{type:'text',placeholder:el.label||'Search','data-search':el.id,'data-fk':'search:'+el.id,'aria-label':el.label||'Search'});var key=el.collection||'';i.value=el.param?(q[el.param]||''):(search[key]||'');i.addEventListener('input',function(){if(mode!=='preview')return;if(el.param){setParam(el.param,i.value,true)}else{search[key]=i.value;refreshTables()}});node=i}
  else if(k==='field')node=renderField(scr,el);
  else if(k==='button'||k==='link')node=renderButton(scr,el);
  else if(k==='badge')node=h('span',{class:'badge'},[el.label||el.text||'']);
  else if(k==='message')node=h('div',{class:'msg'},[el.text||el.label||'']);
  else if(k==='form')node=h('h3',{},[el.label||'']);
  else if((k==='modal'||k==='drawer')&&el.param)return null;
  else node=h('div',{},[el.label||el.text||k]);
  var wrap=h('div',{class:'el'+(k==='filter'||k==='field'?' row-el':''),'data-el':scr.id+'#'+el.id,'data-kind':k,'data-tag':(el.requirementIds||[]).concat(el.acIds||[]).join(' ')||el.id},[node]);
  if(sel===scr.id+'#'+el.id)wrap.classList.add('sel');
  var cb=h('button',{type:'button',class:'pv-cbtn','aria-label':'Comment on '+el.id},['comment']);cb.addEventListener('click',function(e){e.stopPropagation();commentFor(scr.id+'#'+el.id)});wrap.appendChild(cb);
  return wrap
}
// a search box only narrows the tables: the box itself is never rebuilt, so focus and caret stay where they are
function refreshTables(){var scr=screenById(cur);if(!scr)return;$$('.el[data-kind=table],.el[data-kind=list]',host).forEach(function(w){var p=w.getAttribute('data-el').split('#');var el=scr.elements.filter(function(e){return e.id===p[1]})[0];if(el)w.replaceChild(renderTable(scr,el),w.firstChild)})}
// ---- main render
var want=null;
function render(){
  var a=document.activeElement,fk=a&&a.getAttribute&&a.getAttribute('data-fk'),selStart=null;
  if(fk&&a.setSelectionRange&&a.type==='text'){try{selStart=[a.selectionStart,a.selectionEnd]}catch(e){}}
  host.textContent='';
  var scr=screenById(cur);
  $$('#proto-nav button').forEach(function(b){var on=b.getAttribute('data-screen')===cur;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on))});
  if(document.activeElement!==urlIn)urlIn.value=buildUrl(cur,q);
  var sw=$('#proto-state');
  if(!scr){sw.textContent='';sw.disabled=true;host.appendChild(h('h2',{},['Page not found']));host.appendChild(emptyMsg('There is no screen "'+cur+'" in this prototype.'));inspectorShow();return}
  sw.disabled=false;sw.textContent='';var states=scr.states&&scr.states.length?scr.states:['default'];states.forEach(function(s){var o=h('option',{value:s},[s]);if(s===stateName)o.selected=true;sw.appendChild(o)});
  if(states.indexOf(stateName)<0)stateName='default';
  host.appendChild(h('h2',{},[scr.title]));if(scr.description)host.appendChild(h('p',{class:'lead'},[scr.description]));
  var overlays=[];
  if(stateName==='default')normalize(scr);
  if(stateName!=='default'){host.appendChild(h('div',{class:'state-msg '+stateName,'data-state':stateName},[stateText(scr,stateName)]))}
  else{
    scr.elements.forEach(function(el){
      if(!shown(el,scr))return;
      if(el.allowedRoles&&el.allowedRoles.length&&el.allowedRoles.indexOf(role)<0){host.appendChild(h('div',{class:'el','data-el':scr.id+'#'+el.id},[h('div',{class:'denied'},['Not available for role "'+role+'"'])]));return}
      if((el.kind==='modal'||el.kind==='drawer')&&el.param){var o=renderOverlay(scr,el);if(o)overlays.push(o);return}
      var w=renderEl(scr,el);if(w)host.appendChild(w)});
    if(form._ok===scr.id)host.appendChild(h('div',{class:'msg ok',role:'status'},['Saved (mock data only).']));
  }
  var openNow={};
  host.classList.toggle('with-drawer',overlays.some(function(o){return !o.modal}));
  overlays.forEach(function(o){openNow[o.key]=true;if(o.modal)host.appendChild(h('div',{class:'pv-backdrop'}));host.appendChild(o.node)});
  // focus: a newly opened overlay takes focus; a closed one gives it back; otherwise keep the control the person was using
  var fresh=overlays.filter(function(o){return !opened[o.key]})[0],closed=Object.keys(opened).filter(function(k){return !openNow[k]});
  var target=null;
  if(fresh&&mode==='preview')target=fresh.node;
  else if(closed.length&&opener)target=by('data-fk',opener.fk,host);
  else if(fk)target=by('data-fk',fk,host);
  if(want){target=by('data-fk',want,host)||target;want=null}
  opened=openNow;
  if(target&&target.focus){try{target.focus({preventScroll:false});if(selStart&&target.setSelectionRange)target.setSelectionRange(selStart[0],selStart[1])}catch(e){}}
  inspectorShow();
}
// ---- keyboard: Escape closes the top overlay; Tab stays inside a modal
document.addEventListener('keydown',function(e){
  if(mode!=='preview')return;
  var ovs=$$('.pv-overlay',host);if(!ovs.length)return;
  var top=ovs.filter(function(o){return o.classList.contains('modal')})[0]||ovs[ovs.length-1];
  if(e.key==='Escape'){var el=null;var scr=screenById(cur);if(scr)scr.elements.forEach(function(x){if(scr.id+'#'+x.id===top.getAttribute('data-overlay'))el=x});if(el&&el.param){e.preventDefault();setParam(el.param,'')}}
  else if(e.key==='Tab'&&top.classList.contains('modal')){var f=$$('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',top).filter(function(x){return !x.disabled});if(!f.length)return;var first=f[0],last=f[f.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===top)){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
});
// ---- modes: Preview (use it), Inspect (what does it cover), Review (comment on it)
function setMode(m){mode=m;frame.setAttribute('data-mode',m);$$('#pv-mode button').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===m))});if(m==='inspect')showSide('inspect');if(m==='review')showSide('review')}
$$('#pv-mode button').forEach(function(b){b.addEventListener('click',function(){setMode(b.getAttribute('data-mode'))})});
function showSide(name){$$('[data-side]').forEach(function(b){b.setAttribute('aria-selected',String(b.getAttribute('data-side')===name))});$$('[data-sidepanel]').forEach(function(p){p.hidden=p.getAttribute('data-sidepanel')!==name})}
$$('[data-side]').forEach(function(b){b.addEventListener('click',function(){showSide(b.getAttribute('data-side'))})});
host.addEventListener('click',function(e){if(mode==='preview')return;var w=e.target.closest&&e.target.closest('[data-el]');if(!w||(e.target.closest&&e.target.closest('.pv-cbtn')))return;e.preventDefault();e.stopPropagation();select(w.getAttribute('data-el'));if(mode==='review')commentFor(w.getAttribute('data-el'))},true);
function select(key){sel=key;$$('[data-el]',host).forEach(function(n){n.classList.toggle('sel',n.getAttribute('data-el')===key)});inspectorShow()}
function elOf(key){var p=String(key||'').split('#');var s=screenById(p[0]);return s?{scr:s,el:s.elements.filter(function(e){return e.id===p[1]})[0]}:null}
function label(key){var o=elOf(key);return o&&o.el?(o.scr.title+' > '+(o.el.label||o.el.text||o.el.kind)):key}
function behaviour(el){var out=[];if(el.param&&(el.kind==='filter'||el.kind==='tabs'||el.kind==='drawer'||el.kind==='modal'))out.push('Reads and writes the URL parameter "'+el.param+'"');(el.filters||[]).forEach(function(f){out.push('Rows are narrowed by "'+f.param+'" on field "'+f.field+'"')});if(el.rowOpens)out.push('A click on a row opens '+el.rowOpens);if(el.showWhen)out.push('Shown only while '+el.showWhen.param+(el.showWhen.equals!==undefined?' = '+el.showWhen.equals:el.showWhen.notEquals!==undefined?' is not '+el.showWhen.notEquals:el.showWhen.present?' is set':' is not set'));if(el.allowedRoles&&el.allowedRoles.length)out.push('Roles: '+el.allowedRoles.join(', '));return out}
function inspectorShow(){
  var box=$('#pv-inspector');if(!box)return;box.textContent='';
  var o=elOf(sel);
  if(!o||!o.el){box.appendChild(h('p',{class:'muted'},['Switch to Inspect and click anything in the prototype to see which requirement and criteria it covers.']));return}
  var el=o.el;box.appendChild(h('h3',{},[el.label||el.text||el.kind]));box.appendChild(h('p',{class:'meta'},[el.kind+' on "'+o.scr.title+'"'+(el.intent?' - '+el.intent:'')+' - '+o.scr.id+'#'+el.id]));
  var reqs=el.requirementIds||[],acs=el.acIds||[];
  if(!reqs.length&&!acs.length)box.appendChild(h('p',{class:'meta'},['Not linked to a requirement.']));
  reqs.forEach(function(id){var r=D.trace&&D.trace[id];box.appendChild(h('h3',{},[id]));if(r)box.appendChild(h('p',{style:'margin:2px 0'},[r.statement]))});
  if(acs.length){box.appendChild(h('h3',{},['Acceptance criteria']));var ul=h('ul',{});acs.forEach(function(id){var t=D.acText&&D.acText[id];ul.appendChild(h('li',{},[id+(t?': '+t:'')]))});box.appendChild(ul)}
  var b=behaviour(el);if(b.length){box.appendChild(h('h3',{},['Behaviour']));var u2=h('ul',{});b.forEach(function(x){u2.appendChild(h('li',{},[x]))});box.appendChild(u2)}
}
// ---- comments
function addFb(target,text){var box=$('#fb-list');var ta=h('textarea',{'data-fb':target,'aria-label':'Comment on '+label(target),rows:'3'});if(text)ta.value=text;
  var rm=h('button',{type:'button','aria-label':'Remove this comment'},['Remove']);var card=h('div',{class:'fbcard'},[h('div',{class:'top'},[h('div',{class:'meta'},[target==='prototype'?'About the prototype':label(target)]),rm]),ta]);rm.addEventListener('click',function(){card.remove()});box.appendChild(card);return ta}
function commentFor(key){showSide('review');var ta=by('data-fb',key);if(!ta)ta=addFb(key);if(ta.scrollIntoView)ta.scrollIntoView({block:'center'});ta.focus()}
var add=$('#fb-add');if(add)add.addEventListener('click',function(){showSide('review');addFb('prototype').focus()});
// ---- navigation, toolbar
$$('#proto-nav button').forEach(function(b){b.addEventListener('click',function(){stateName='default';go(b.getAttribute('data-screen'),{})})});
var swEl=$('#proto-state');swEl.addEventListener('change',function(){stateName=swEl.value;render()});
var rl=$('#proto-role');if(rl){rl.addEventListener('change',function(){role=rl.value;render()})}
var dsSel=$('#proto-data');if(dsSel){dsSel.addEventListener('change',function(){dsId=dsSel.value;loadData();search={};render()})}
var rs=$('#proto-reset');if(rs)rs.addEventListener('click',function(){loadData();search={};form={};formErr={};render()});
$$('#pv-vp button').forEach(function(b){b.addEventListener('click',function(){var m=b.getAttribute('data-vp')==='mobile';device.classList.toggle('mobile',m);$$('#pv-vp button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))})})});
$('#proto-addr').addEventListener('submit',function(e){e.preventDefault();var u=parseUrl(urlIn.value);stateName='default';cur=u.screen||startId;q=u.query;pushUrl(false);render()});
function syncFromHash(){var u=parseUrl(location.hash);cur=u.screen||startId;q=u.query;stateName='default';render()}
window.addEventListener('popstate',syncFromHash);window.addEventListener('hashchange',syncFromHash);
// ---- scenarios
function applyScenario(sc){
  dsId=sc.dataset||'';if(dsSel)dsSel.value=dsId;role=sc.role||role0;if(rl)rl.value=role;stateName='default';search={};form={};formErr={};loadData();cur=sc.screen||startId;q=clone(sc.query||{});curScenario=sc.id;pushUrl(false);render()}
function checkScenario(sc){
  var fails=[],ex=sc.expect;if(!ex)return null;
  (ex.rows||[]).forEach(function(r){var w=by('data-el',cur+'#'+r.element,host);var n=w?$$('tr[data-row]',w).length:0;if(n!==r.count)fails.push(r.element+': '+n+' row(s), expected '+r.count)});
  (ex.overlay||[]).forEach(function(o){var n=by('data-overlay',cur+'#'+o.element,host);var st=n?n.getAttribute('data-state'):'closed';if(st!==o.state)fails.push(o.element+' is '+st+', expected '+o.state)});
  var txt=host.textContent;(ex.contains||[]).forEach(function(t){if(txt.indexOf(t)<0)fails.push('missing text "'+t+'"')});(ex.absent||[]).forEach(function(t){if(txt.indexOf(t)>=0)fails.push('unexpected text "'+t+'"')});
  (ex.noQuery||[]).forEach(function(k){if(q[k]!==undefined&&q[k]!=='')fails.push('?'+k+' is still set')});Object.keys(ex.query||{}).forEach(function(k){if(q[k]!==ex.query[k])fails.push('?'+k+' is "'+(q[k]||'')+'", expected "'+ex.query[k]+'"')});
  return fails}
function drawScenarios(){
  var box=$('#pv-scenarios');if(!box)return;box.textContent='';
  if(!P.scenarios.length){box.appendChild(h('p',{class:'muted'},['This prototype defines no scenarios yet. Ask Claude to add the situations that should be checked.']));return}
  P.scenarios.forEach(function(sc){
    var r=results[sc.id];var dot=h('span',{class:'dot '+(r?(r.length?'bad':'ok'):'')},[r===undefined?'○':r===null?'–':r.length?'✗':'✓']);
    var b=h('button',{type:'button',class:'sc'+(curScenario===sc.id?' cur':''),'data-scenario':sc.id},[dot,h('span',{},[sc.title,sc.description?h('small',{},[sc.description]):null])]);
    b.addEventListener('click',function(){applyScenario(sc);results[sc.id]=checkScenario(sc);drawScenarios()});
    box.appendChild(b);if(r&&r.length)r.forEach(function(f){box.appendChild(h('div',{class:'fail'},[f]))})});
}
var runAll=$('#sc-run-all');if(runAll)runAll.addEventListener('click',function(){
  var keep={cur:cur,q:clone(q),ds:dsId,role:role,sc:curScenario};
  quiet=true;try{P.scenarios.forEach(function(sc){applyScenario(sc);results[sc.id]=checkScenario(sc)})}finally{quiet=false}
  dsId=keep.ds;if(dsSel)dsSel.value=dsId;role=keep.role;if(rl)rl.value=role;loadData();cur=keep.cur;q=keep.q;curScenario=keep.sc;pushUrl(true);render();drawScenarios();
  var bad=Object.keys(results).filter(function(k){return results[k]&&results[k].length}).length,done=Object.keys(results).filter(function(k){return results[k]!==null}).length;
  var s=$('#sc-summary');if(s)s.textContent=bad?bad+' of '+done+' checked scenarios failed':done+' of '+done+' checked scenarios passed'});
$$('[data-goto]').forEach(function(b){b.addEventListener('click',function(){var key=b.getAttribute('data-goto');var parts=key.split('#');stateName='default';setMode('inspect');go(parts[0],{});select(key);var w=by('data-el',key,host);if(w&&w.scrollIntoView)w.scrollIntoView({block:'center'})})});
// ---- start
if(location.hash&&location.hash.length>1){var u0=parseUrl(location.hash);cur=u0.screen||startId;q=u0.query}
setMode('preview');drawScenarios();render();
})()}
`;

type Group = { id: string; label: string; items: string[] };

/** Coverage grouped by requirement, collapsed by default: what in the prototype serves it and which scenarios exercise it. */
function coverage(state: WorkflowState, proto: Prototype): string {
  const reqs = state.requirements.filter((r) => r.status !== "superseded" && r.scope === "in");
  const groups = new Map<string, Group>(reqs.map((r) => [r.id, { id: r.id, label: r.statement, items: [] }]));
  const unlinked: string[] = [];
  const elementLine = (screen: PrototypeScreen, e: PrototypeElement) => `<li><button type="button" class="gt" data-goto="${esc(screen.id)}#${esc(e.id)}">${esc(screen.title)} &rsaquo; ${esc(e.label || e.text || e.kind)}</button> <span class="meta">${esc(e.kind)}${e.acIds.length ? ` · ${esc(e.acIds.join(", "))}` : ""}</span></li>`;
  for (const screen of proto.screens)
    for (const e of screen.elements) {
      if (!e.requirementIds.length && !e.acIds.length) {
        if (e.kind !== "heading" && e.kind !== "text") unlinked.push(elementLine(screen, e));
        continue;
      }
      const ids = new Set(e.requirementIds);
      for (const ac of e.acIds) for (const r of reqs) if (r.acceptanceCriteria.some((c) => c.id === ac)) ids.add(r.id);
      for (const id of ids) groups.get(id)?.items.push(elementLine(screen, e));
    }
  for (const sc of proto.scenarios) {
    const ids = new Set(sc.requirementIds);
    for (const ac of sc.acIds) for (const r of reqs) if (r.acceptanceCriteria.some((c) => c.id === ac)) ids.add(r.id);
    for (const id of ids) groups.get(id)?.items.push(`<li>Scenario: ${esc(sc.title)}</li>`);
  }
  for (const ep of proto.endpoints) for (const id of new Set(ep.requirementIds)) groups.get(id)?.items.push(`<li>${esc(ep.method)} ${esc(ep.path)}</li>`);
  const rows = [...groups.values()]
    .map((g) => `<details class="cov-req"><summary><strong>${esc(g.id)}</strong> <span class="meta">${g.items.length ? `${g.items.length} item(s)` : "not covered by the prototype"}</span><br><span class="meta">${esc(g.label)}</span></summary><ul>${g.items.join("") || `<li class="muted">Nothing in the prototype is linked to this requirement.</li>`}</ul></details>`)
    .join("");
  const covered = [...groups.values()].filter((g) => g.items.length).length;
  return `<details class="pv-cov"><summary>Coverage: ${covered} of ${groups.size} requirement(s) are shown in the prototype</summary><div class="covbody">${rows || `<p class="muted">No requirements in scope.</p>`}${unlinked.length ? `<details class="cov-req"><summary>Interactive elements not linked to a requirement (${unlinked.length})</summary><ul>${unlinked.join("")}</ul></details>` : ""}</div></details>`;
}

function fidelity(proto: Prototype): string {
  const src = proto.styles.sources;
  const items = [
    "Mock data only. Nothing here reaches a real system, and nothing you do here changes the saved prototype.",
    src.length
      ? `Look: colours, font, corner radius and spacing were read from ${src.map((s) => esc(s.file)).join(", ")}. The application's own component library, icons and exact page layout are not reproduced, so this is faithful in tone, not pixel-identical.`
      : "Neutral look: no application styles were found, so colours, fonts and spacing are generic.",
    ...proto.limitations.map((l) => esc(l)),
  ];
  return `<details class="pv-about"><summary>What this prototype is, and is not</summary><div class="covbody"><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div></details>`;
}

export function renderPrototypeBody(state: WorkflowState, proto: Prototype, staleBanner: string): { body: string; clientData: Record<string, unknown> } {
  const vars = prototypeVars(proto);
  const scenarios = proto.scenarios.length;
  const feedback = proto.feedback
    .map((f) => `<div class="fbcard"><div class="top"><label class="marks"><input type="checkbox" data-resolve="${esc(f.id)}"${f.resolved ? " checked disabled" : ""}> ${f.resolved ? "Resolved" : "Mark resolved"}</label><span class="meta">${esc(f.target)}</span></div><p style="margin:4px 0">${esc(f.comment)}</p></div>`)
    .join("");
  const viewer =
    proto.kind === "ui"
      ? `<div class="pv-bar" role="toolbar" aria-label="Prototype controls">
<div><div class="meta" id="pv-mode-l">Mode</div><div class="seg" id="pv-mode" role="group" aria-labelledby="pv-mode-l"><button type="button" data-mode="preview" aria-pressed="true">Preview</button><button type="button" data-mode="inspect" aria-pressed="false">Inspect</button><button type="button" data-mode="review" aria-pressed="false">Review</button></div></div>
<div><div class="meta" id="pv-vp-l">Screen size</div><div class="seg" id="pv-vp" role="group" aria-labelledby="pv-vp-l"><button type="button" data-vp="desktop" aria-pressed="true">Desktop</button><button type="button" data-vp="mobile" aria-pressed="false">Mobile</button></div></div>
${proto.datasets.length ? `<label>Data<select id="proto-data"><option value="">${esc("Default data")}</option>${proto.datasets.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join("")}</select></label>` : ""}
${proto.roles.length ? `<label>Role<select id="proto-role">${proto.roles.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>` : ""}
<label>Screen state<select id="proto-state"></select></label>
<button id="proto-reset" type="button">Reset mock data</button></div>
<div class="pv-grid"><section aria-label="Prototype">
<div class="pv-device" id="pv-device"><form class="pv-addr" id="proto-addr" autocomplete="off"><span aria-hidden="true">prototype://</span><input id="proto-url" type="text" aria-label="Prototype address (screen and query parameters)" spellcheck="false"></form>
<div class="proto" id="proto-frame" data-mode="preview" style="${esc(vars)}"><div class="nav" id="proto-nav" role="tablist" aria-label="Screens">${proto.screens.map((s) => `<button type="button" role="tab" data-screen="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>
<div class="screen" id="proto-screen" tabindex="-1"></div></div></div>
${fidelity(proto)}</section>
<aside class="pv-side" aria-label="Review panel"><div class="pv-tabs" role="tablist"><button type="button" role="tab" data-side="review" aria-selected="true">Review</button><button type="button" role="tab" data-side="inspect" aria-selected="false">Inspector</button><button type="button" role="tab" data-side="scenarios" aria-selected="false">Scenarios${scenarios ? ` (${scenarios})` : ""}</button></div>
<div class="pv-panel" data-sidepanel="review"><p class="meta">Use the prototype in Preview. Switch to Review and click anything to leave a comment on it.</p><div id="fb-list"></div><button id="fb-add" type="button">Comment on the prototype as a whole</button>${feedback ? `<h3>Earlier comments</h3>${feedback}` : ""}</div>
<div class="pv-panel" data-sidepanel="inspect" hidden><div id="pv-inspector"></div></div>
<div class="pv-panel" data-sidepanel="scenarios" hidden><div class="row" style="justify-content:space-between;align-items:center"><span class="meta" id="sc-summary" role="status"></span>${scenarios ? `<button type="button" id="sc-run-all">Run all checks</button>` : ""}</div><div id="pv-scenarios"></div></div></aside></div>
${coverage(state, proto)}`
      : `<p class="meta">Technical prototype of an API: request and response examples, no screens.</p>${proto.endpoints
          .map(
            (e) => `<div class="card"><h2>${pill(e.method)} ${esc(e.path)}</h2><p>${esc(e.summary)}</p><div class="meta">${e.auth ? `Auth: ${esc(e.auth)} · ` : ""}${esc([...e.requirementIds, ...e.acIds].join(" "))}</div>
${e.request !== undefined ? `<h3>Request</h3><pre>${esc(JSON.stringify(e.request, null, 2))}</pre>` : ""}${e.responses.map((r) => `<h3>Response ${r.status} ${esc(r.description)}</h3>${r.example !== undefined ? `<pre>${esc(JSON.stringify(r.example, null, 2))}</pre>` : ""}`).join("")}</div>`,
          )
          .join("")}
<div id="fb-list"></div><button id="fb-add" type="button">Add a comment</button>${feedback ? `<h3>Earlier comments</h3>${feedback}` : ""}
${coverage(state, proto)}`;
  const body = `${staleBanner}
<div class="pv-head">${pill(`${proto.kind === "ui" ? "UI" : "API"} prototype`)} ${pill(`revision ${proto.revision}`)} ${pill(proto.status, proto.status === "accepted" ? "ok" : "warn")}${proto.notes ? ` <span class="muted">${esc(proto.notes)}</span>` : ""}</div>
${viewer}`;
  const trace: Record<string, { statement: string }> = {};
  const acText: Record<string, string> = {};
  for (const r of state.requirements) {
    trace[r.id] = { statement: r.statement };
    for (const c of r.acceptanceCriteria) acText[c.id] = c.statement;
  }
  return {
    body,
    clientData: { proto: { kind: proto.kind, startScreen: proto.startScreen, roles: proto.roles, screens: proto.screens, mock: proto.mock, datasets: proto.datasets, scenarios: proto.scenarios }, trace, acText },
  };
}
