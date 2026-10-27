import { fingerprintFor, type ReviewView } from "./review-submission.js";
import { reviewProgress, storyReviewProgress, analyzeStoryCoverage, acceptanceStatus } from "./planning.js";
import type { WorkflowState } from "./workflow.js";

/**
 * Standard, reproducible HTML reviews. Each page is a self-contained file: server-rendered content, inline CSS and a small
 * vanilla script, no network access. The page is a way to look at the artifact and to record decisions; it is never a
 * source of truth. Decisions leave the page as a ReviewSubmission (see review-submission.ts), which the Runtime turns into
 * workflow commands, so the canonical state stays in the workflow store.
 */

export type RenderReviewOptions = {
  reviewId?: string;
  /** Loopback URL the page posts its decisions to. Without it the page offers copy and download. */
  saveUrl?: string;
  /** Per-review token sent with the POST. */
  token?: string;
  generatedAt?: string;
};

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const CSS = `
:root{--bg:#fff;--fg:#1d2330;--muted:#5d6678;--line:#d9dde6;--card:#f7f8fb;--accent:#2457d6;--ok:#17803d;--bad:#b42318;--warn:#a15c00;--okbg:#e7f6ec;--badbg:#fdeceb;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14171f;--fg:#e6e9f0;--muted:#9aa3b5;--line:#2c3242;--card:#1c202b;--accent:#7aa2ff;--ok:#5ad08a;--bad:#ff8a80;--warn:#ffc266;--okbg:#14301f;--badbg:#3a1a18;--on-accent:#0b1020}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:16px 16px 120px}
h1{font-size:22px;margin:8px 0}h2{font-size:17px;margin:0}h3{font-size:14px;margin:12px 0 4px}
.muted{color:var(--muted)}.meta{font-size:13px;color:var(--muted)}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 14px;margin:12px 0}
.card.out{opacity:.6}
.row{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}.row>.grow{flex:1;min-width:200px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted);background:var(--bg)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}
textarea,input[type=text],select{width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
textarea{min-height:44px;resize:vertical}
button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ac{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:8px 0;border-top:1px solid var(--line)}
.marks{display:flex;gap:10px;align-items:center;font-size:13px}.marks label{display:flex;gap:4px;align-items:center;cursor:pointer}
.stale{background:var(--badbg);border:1px solid var(--bad);border-radius:8px;padding:8px 12px;margin:10px 0}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:5}
.bar .grow{flex:1;min-width:160px}
#out{display:none;margin:12px 0}#out textarea{min-height:140px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
#toast{font-size:13px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:13px}
.proto{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
.proto .nav{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border-bottom:1px solid var(--line);background:var(--card)}
.proto .nav button.on{background:var(--p-primary,var(--accent));color:#fff;border-color:transparent}
.proto .screen{padding:14px;font-family:var(--p-font,inherit)}
.proto .btn{background:var(--p-primary,var(--accent));color:#fff;border:0;border-radius:var(--p-radius,6px);padding:6px 14px}
.proto .btn.sec{background:transparent;color:var(--p-primary,var(--accent));border:1px solid var(--p-primary,var(--accent))}
.proto table{border-collapse:collapse;width:100%;font-size:14px}.proto th,.proto td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}
.el{position:relative;margin:10px 0;padding:4px;border:1px dashed transparent;border-radius:6px}
.el:hover{border-color:var(--line)}.el .tag{font-size:11px;color:var(--muted);margin-left:6px}
.denied{background:var(--badbg);color:var(--bad);padding:8px;border-radius:6px}
.state-msg{padding:16px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px;margin:4px 0}
`;

const SCRIPT = `
(function(){
var D=JSON.parse(document.getElementById('praxis-data').textContent);
var $=function(s,r){return (r||document).querySelector(s)};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
function toast(t,bad){var e=$('#toast');e.textContent=t;e.style.color=bad?'var(--bad)':'var(--ok)'}
function val(el){return el?el.value.trim():''}
function num(el){return parseInt(el.getAttribute('data-rev'),10)}
function markOf(root,name){var c=$('input[name="'+name+'"]:checked',root);return c?c.value:null}
function collect(){
  var s={contract:'praxis.review.submission',version:1,reviewId:D.reviewId,view:D.view,workItemId:D.workItemId,baseFingerprint:D.baseFingerprint,submittedAt:new Date().toISOString()};
  if(D.view==='requirements'){
    var reqs=[];
    $$('[data-req]').forEach(function(card){
      var id=card.getAttribute('data-req');var item={id:id,revision:num(card),criteria:[],addCriteria:[],removeCriteria:[]};var touched=false;
      var st=$('[data-f=statement]',card);if(st&&val(st)!==st.getAttribute('data-initial')){item.statement=val(st);touched=true}
      var sc=$('[data-f=scope]',card);if(sc&&sc.value!==sc.getAttribute('data-initial')){item.scope=sc.value;touched=true}
      var sn=$('[data-f=scopeNote]',card);if(sn&&val(sn)!==sn.getAttribute('data-initial')){item.scopeNote=val(sn);touched=true}
      var rc=$('[data-f=comment]',card);if(rc&&val(rc)!==''){item.comment=val(rc);touched=true}
      $$('[data-ac]',card).forEach(function(row){
        var aid=row.getAttribute('data-ac');
        if($('[data-f=remove]',row)&&$('[data-f=remove]',row).checked){item.removeCriteria.push(aid);touched=true;return}
        var c={id:aid,revision:num(row)};var ch=false;
        var m=markOf(row,'m-'+aid);if(m&&m!==row.getAttribute('data-initial-status')){c.status=m;c.from=row.getAttribute('data-initial-status');ch=true}
        var cm=$('[data-f=ac-comment]',row);if(cm&&val(cm)!==cm.getAttribute('data-initial')){c.comment=val(cm);c.fromComment=cm.getAttribute('data-initial')||'';ch=true}
        var ts=$('[data-f=ac-statement]',row);if(ts&&val(ts)!==ts.getAttribute('data-initial')){c.statement=val(ts);ch=true}
        if(ch){item.criteria.push(c);touched=true}
      });
      var add=$('[data-f=add-ac]',card);if(add&&val(add)){val(add).split(/\\n+/).forEach(function(l){l=l.trim();if(l)item.addCriteria.push({statement:l})});touched=true}
      if(touched)reqs.push(item)
    });
    s.requirements={requirements:reqs,acceptAll:!!($('#accept-all')&&$('#accept-all').checked)};
  }
  if(D.view==='prototype'){
    var fb=[];$$('[data-fb]').forEach(function(t){if(val(t))fb.push({target:t.getAttribute('data-fb'),comment:val(t)})});
    var rs=[];$$('[data-resolve]:checked').forEach(function(c){rs.push(c.getAttribute('data-resolve'))});
    s.prototype={feedback:fb,resolve:rs,accept:!!($('#accept-proto')&&$('#accept-proto').checked)};
  }
  if(D.view==='story-plan'){
    var es=[];
    $$('[data-entry]').forEach(function(card){
      var id=card.getAttribute('data-entry');var e={id:id};var ch=false;
      var m=markOf(card,'m-'+id);if(m&&m!==card.getAttribute('data-initial-status')){e.status=m;ch=true}
      var cm=$('[data-f=comment]',card);if(cm&&val(cm)){e.comment=val(cm);ch=true}
      ['title','implementation','userGets'].forEach(function(f){var t=$('[data-f='+f+']',card);if(t&&val(t)!==t.getAttribute('data-initial')){e[f]=val(t);ch=true}});
      var ex=$('[data-f=exclude]',card);if(ex&&val(ex)){e.exclude=val(ex);ch=true}
      var rt=$('[data-f=restore]',card);if(rt&&rt.checked){e.restore=true;ch=true}
      if(ch)es.push(e)
    });
    s.plan={entries:es,agree:!!($('#agree-plan')&&$('#agree-plan').checked)};
  }
  if(D.view==='contracts'){
    var ag=[],rm=[];$$('[data-contract]').forEach(function(card){var c=$('[data-f=agree]',card);if(c&&c.checked)ag.push(card.getAttribute('data-contract'));var r=$('[data-f=remove]',card);if(r&&r.checked)rm.push(card.getAttribute('data-contract'))});
    s.contracts={agree:ag,remove:rm};
  }
  if(D.view==='stories'){
    var items=[],sts=[];
    $$('[data-story]').forEach(function(card){
      var id=card.getAttribute('data-story');var rev=num(card);var st={storyId:id,revision:rev};var ch=false;
      $$('[data-key]',card).forEach(function(row){
        var key=row.getAttribute('data-key');var m=markOf(row,'m-'+id+'-'+key);
        var cm=$('[data-f=comment]',row);
        if(m&&(m!==row.getAttribute('data-initial-status')||(cm&&val(cm)))){var it={storyId:id,revision:rev,key:key,from:row.getAttribute('data-initial-status'),status:m};if(cm&&val(cm))it.comment=val(cm);items.push(it)}
      });
      var n=$('[data-f=narrative]',card);if(n&&val(n)!==n.getAttribute('data-initial')){st.narrative=val(n);ch=true}
      var o=$('[data-f=objective]',card);if(o&&val(o)!==o.getAttribute('data-initial')){st.objective=val(o);ch=true}
      var ex=$('[data-f=exclude]',card);if(ex&&val(ex)){st.exclude=val(ex);ch=true}
      var rt=$('[data-f=restore]',card);if(rt&&rt.checked){st.restore=true;ch=true}
      var all=$('[data-f=accept-story]',card);if(all&&all.checked){st.acceptAll=true;ch=true}
      if(ch)sts.push(st)
    });
    s.stories={items:items,stories:sts,accept:!!($('#accept-stories')&&$('#accept-stories').checked)};
  }
  return s
}
function showOut(text){var o=$('#out');o.style.display='block';$('textarea',o).value=text}
function summary(s){return JSON.stringify(s,null,2)}
$('#btn-save').addEventListener('click',function(){
  var s=collect();var text=summary(s);
  if(!D.saveUrl){showOut(text);toast('No live connection: copy or download the decisions and give them to Claude: it records them with praxis_review_apply after you approve them in the dialog.',false);return}
  toast('Saving...',false);
  fetch(D.saveUrl,{method:'POST',headers:{'content-type':'application/json','x-praxis-review-token':D.token||''},body:JSON.stringify(s)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){
    if(!x.ok){showOut(text);toast('Not saved ('+(x.j&&x.j.error||'error')+'). Decisions are below: copy them to Claude.',true);return}
    var c=(x.j.conflicts||[]).length;
    toast(c?('Saved: '+(x.j.applied||0)+' change(s) applied. NOT saved, '+c+' conflict(s) - this page is out of date: '+x.j.conflicts.map(function(k){return k.item+' ('+k.reason+')'}).join('; ')+'. Reload the page to see the current state, then decide again.'):('Saved: '+(x.j.applied||0)+' change(s) applied. Reload to see the new revision.'),c>0);
  }).catch(function(){showOut(text);toast('Cannot reach Praxis (the review session ended). Decisions are below: copy them to Claude.',true)})
});
$('#btn-copy').addEventListener('click',function(){var t=summary(collect());showOut(t);if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){toast('Copied.',false)},function(){toast('Select and copy the text below.',false)})}else toast('Select and copy the text below.',false)});
$('#btn-download').addEventListener('click',function(){var t=summary(collect());var b=new Blob([t],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=D.view+'-review-'+D.workItemId+'.json';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},0)});
var acc=$('#btn-accept-all');if(acc)acc.addEventListener('click',function(){$$('input[type=radio][value=accepted]').forEach(function(r){if(!r.closest('.card.out'))r.checked=true})});
$$('[data-accept-card]').forEach(function(b){b.addEventListener('click',function(){$$('input[type=radio][value=accepted]',b.closest('.card')).forEach(function(r){r.checked=true})})});
// prototype viewer
if(D.view==='prototype'&&D.proto&&D.proto.kind==='ui'){
  var P=D.proto,mock=JSON.parse(JSON.stringify(P.mock)),cur=P.startScreen||(P.screens[0]&&P.screens[0].id),role=(P.roles&&P.roles[0])||'',stateName='default',modal=null;
  var host=$('#proto-screen');
  function h(t,a,c){var e=document.createElement(t);for(var k in (a||{})){if(k==='class')e.className=a[k];else e.setAttribute(k,a[k])}(c||[]).forEach(function(x){e.appendChild(typeof x==='string'?document.createTextNode(x):x)});return e}
  function tag(el){var t=[].concat(el.requirementIds||[],el.acIds||[]);return t.length?h('span',{class:'tag'},[t.join(' ')]):document.createTextNode('')}
  function coll(id){return mock.filter(function(c){return c.id===id})[0]}
  function fillTable(box,el){
    box.textContent='';
    var c=coll(el.collection);
    if(!c){box.appendChild(h('div',{class:'state-msg'},['No data']));return}
    var cols=el.columns&&el.columns.length?el.columns:c.fields.map(function(f){return f.key});
    var t=h('table',{},[]);t.appendChild(h('tr',{},cols.map(function(key){var f=c.fields.filter(function(x){return x.key===key})[0];return h('th',{},[f?f.label:key])})));
    var rows=c.rows.filter(function(r){return !(P._q&&P._q[el.id])||JSON.stringify(r).toLowerCase().indexOf(P._q[el.id].toLowerCase())>=0});
    if(!rows.length)box.appendChild(h('div',{class:'state-msg'},['No rows']));
    rows.forEach(function(r){t.appendChild(h('tr',{},cols.map(function(key){return h('td',{},[String(r[key]==null?'':r[key])])})))});
    if(rows.length)box.appendChild(t)
  }
  function render(){
    P._tables=[];
    host.textContent='';
    var scr=P.screens.filter(function(s){return s.id===cur})[0];if(!scr)return;
    var sw=$('#proto-state');sw.textContent='';scr.states.forEach(function(s){var o=h('option',{value:s},[s]);if(s===stateName)o.selected=true;sw.appendChild(o)});
    if(scr.states.indexOf(stateName)<0)stateName='default';
    host.appendChild(h('h2',{},[scr.title]));if(scr.description)host.appendChild(h('p',{class:'muted'},[scr.description]));
    if(stateName!=='default'){host.appendChild(h('div',{class:'state-msg'},[(scr.stateMessages&&scr.stateMessages[stateName])||({loading:'Loading...',empty:'Nothing here yet.',error:'Something went wrong.',success:'Done.',denied:'You do not have permission.'}[stateName]||stateName)]));return}
    scr.elements.forEach(function(el){
      var wrap=h('div',{class:'el','data-el':scr.id+'#'+el.id});
      if(el.allowedRoles&&el.allowedRoles.length&&el.allowedRoles.indexOf(role)<0){wrap.appendChild(h('div',{class:'denied'},['Not available for role "'+role+'"']));host.appendChild(wrap);return}
      var k=el.kind;
      if(k==='heading')wrap.appendChild(h('h3',{},[el.label||el.text||'']));
      else if(k==='text')wrap.appendChild(h('p',{},[el.text||el.label||'']));
      else if(k==='table'||k==='list'){
        var box=h('div',{class:'tblbox'});wrap.appendChild(box);(P._tables=P._tables||[]).push({wrap:box,el:el});fillTable(box,el)}
      else if(k==='__old_table'){
        var c=coll(el.collection);
        if(!c){wrap.appendChild(h('div',{class:'state-msg'},['No data']))}
        else{
          var cols=el.columns&&el.columns.length?el.columns:c.fields.map(function(f){return f.key});
          var q=$('[data-search="'+el.id+'"]');
          var t=h('table',{},[]);var hr=h('tr',{},cols.map(function(key){var f=c.fields.filter(function(x){return x.key===key})[0];return h('th',{},[f?f.label:key])}));t.appendChild(hr);
          var rows=c.rows.filter(function(r){return !(P._q&&P._q[el.id])||JSON.stringify(r).toLowerCase().indexOf(P._q[el.id].toLowerCase())>=0});
          if(!rows.length)wrap.appendChild(h('div',{class:'state-msg'},['No rows']));
          rows.forEach(function(r){t.appendChild(h('tr',{},cols.map(function(key){return h('td',{},[String(r[key]==null?'':r[key])])})))});
          if(rows.length)wrap.appendChild(t)}
      }
      else if(k==='search'){var i=h('input',{type:'text',placeholder:el.label||'Search','data-search':el.id});i.value=(P._q&&P._q[el.id])||'';if(P._focus===el.id){setTimeout(function(){i.focus();try{i.setSelectionRange(i.value.length,i.value.length)}catch(e){}},0)}i.addEventListener('input',function(){P._focus=el.id;P._q=P._q||{};P._q[el.collection||'']=i.value;(P.screens.filter(function(s){return s.id===cur})[0].elements).forEach(function(e2){if(e2.collection===el.collection){P._q[e2.id]=i.value}});(P._tables||[]).forEach(function(x){fillTable(x.wrap,x.el)})});wrap.appendChild(i)}
      else if(k==='field'){wrap.appendChild(h('label',{},[el.label||el.field||'']));wrap.appendChild(h('input',{type:'text',placeholder:el.text||''}))}
      else if(k==='button'||k==='link'){
        var b=h('button',{class:'btn'+(k==='link'?' sec':''),type:'button'},[el.label||'Button']);
        b.addEventListener('click',function(e){e.stopPropagation();
          if(el.navigatesTo){cur=el.navigatesTo;stateName='default';render();syncNav()}
          else if(el.action==='add-row'&&coll(el.collection)){var c=coll(el.collection),row={};c.fields.forEach(function(f){row[f.key]=f.type==='number'?c.rows.length+1:f.type==='boolean'?false:'New '+f.label});c.rows.push(row);render()}
          else if(el.action==='delete-row'&&coll(el.collection)){coll(el.collection).rows.pop();render()}
          else if(el.action==='submit'){stateName='success';render()}
        });wrap.appendChild(b)}
      else wrap.appendChild(h('div',{},[el.label||el.text||k]));
      wrap.appendChild(tag(el));
      var cb=h('button',{type:'button',style:'font-size:11px;margin-left:8px;padding:0 6px','aria-label':'Comment on '+el.id},['comment']);
      cb.addEventListener('click',function(e){e.stopPropagation();var ta=$('[data-fb="'+scr.id+'#'+el.id+'"]');if(!ta)ta=addFb(scr.id+'#'+el.id);if(ta.scrollIntoView)ta.scrollIntoView({block:'center'});ta.focus()});
      wrap.appendChild(cb);
      host.appendChild(wrap)
    })
  }
  function addFb(target){var box=$('#fb-list');var w=h('div',{class:'card'},[h('div',{class:'meta'},['Comment on '+target]),h('textarea',{'data-fb':target})]);box.appendChild(w);return $('textarea',w)}
  function syncNav(){$$('#proto-nav button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-screen')===cur)})}
  $$('#proto-nav button').forEach(function(b){b.addEventListener('click',function(){cur=b.getAttribute('data-screen');stateName='default';render();syncNav()})});
  var sw=$('#proto-state');sw.addEventListener('change',function(){stateName=sw.value;render()});
  var rl=$('#proto-role');if(rl){rl.addEventListener('change',function(){role=rl.value;render()})}
  var rs=$('#proto-reset');if(rs)rs.addEventListener('click',function(){mock=JSON.parse(JSON.stringify(P.mock));P._q={};render()});
  var add=$('#fb-add');if(add)add.addEventListener('click',function(){addFb('prototype')});
  syncNav();render();
}
})();
`;

function shell(state: WorkflowState, view: ReviewView, title: string, body: string, data: Record<string, unknown>, options: RenderReviewOptions, barExtra: string): string {
  const payload = {
    reviewId: options.reviewId ?? `${view}-${state.workItem.id}`,
    view,
    workItemId: state.workItem.id,
    baseFingerprint: fingerprintFor(state, view),
    saveUrl: options.saveUrl,
    token: options.token,
    ...data,
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="meta">Work item ${esc(state.workItem.id)} · ${esc(state.workItem.title)} · phase ${esc(state.phase)}${options.generatedAt ? ` · generated ${esc(options.generatedAt)}` : ""}. This page records decisions; the workflow state in Praxis is the source of truth.</p>
${body}
<div id="out"><p class="meta">Decisions (give this to Claude if the page could not save them):</p><textarea readonly aria-label="Decisions"></textarea></div>
</main>
<div class="bar" role="region" aria-label="Actions">${barExtra}<span class="grow" id="toast" role="status" aria-live="polite"></span>
<button id="btn-copy" type="button">Copy decisions</button><button id="btn-download" type="button">Download</button><button id="btn-save" class="primary" type="button">Save decisions</button></div>
<script type="application/json" id="praxis-data">${jsonForScript(payload)}</script>
<script>${SCRIPT}</script>
</body></html>`;
}

function marks(name: string, current: string, labels = { accepted: "Accept", rejected: "Reject", pending: "Undecided" }): string {
  return `<div class="marks" role="radiogroup">${(["accepted", "rejected", "pending"] as const)
    .map((v) => `<label><input type="radio" name="${esc(name)}" value="${v}"${v === current ? " checked" : ""}> ${labels[v]}</label>`)
    .join("")}</div>`;
}

function pill(text: string, kind = ""): string {
  return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function staleBanner(state: WorkflowState, phase: "requirements_review" | "prototype" | "story_plan" | "stories_review"): string {
  return acceptanceStatus(state, phase) === "stale" ? `<div class="stale"><strong>Changed since you accepted it.</strong> The earlier acceptance no longer applies; review the changes and accept again.</div>` : "";
}

// --- requirements ------------------------------------------------------------------------------------------------

export function renderRequirementsReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const all = state.requirements.filter((r) => r.status !== "superseded");
  const progress = reviewProgress(state);
  const cards = all
    .map((req) => {
      const out = req.scope !== "in";
      const criteria = req.acceptanceCriteria
        .map(
          (ac) => `<div class="ac" data-ac="${esc(ac.id)}" data-rev="${ac.revision}" data-initial-status="${esc(ac.review.status)}">
<div><strong>${esc(ac.id)}</strong></div>
<div><textarea data-f="ac-statement" data-initial="${esc(ac.statement)}" aria-label="Text of ${esc(ac.id)}">${esc(ac.statement)}</textarea>${ac.review.previous && ac.review.status === "pending" ? `\n<div class="meta" data-previous>Before this revision: ${esc(ac.review.previous.status)}${ac.review.previous.comment ? ` - "${esc(ac.review.previous.comment)}"` : ""}</div>` : ""}
<div class="row" style="margin-top:4px">${marks(`m-${ac.id}`, ac.review.status)}<input type="text" data-f="ac-comment" data-initial="${esc(ac.review.comment ?? "")}" placeholder="Comment" value="${esc(ac.review.comment ?? "")}" aria-label="Comment on ${esc(ac.id)}" style="flex:1;min-width:160px">
<label class="marks"><input type="checkbox" data-f="remove"> Remove</label></div></div></div>`,
        )
        .join("");
      return `<section class="card${out ? " out" : ""}" data-req="${esc(req.id)}" data-rev="${req.revision}">
<div class="row"><h2 class="grow">${esc(req.id)} ${pill(`r${req.revision}`)} ${pill(req.status)}${out ? " " + pill(req.scope, "warn") : ""}</h2></div>
<textarea data-f="statement" data-initial="${esc(req.statement)}" aria-label="Statement of ${esc(req.id)}">${esc(req.statement)}</textarea>
<div class="row" style="margin-top:6px"><div><label class="meta">Scope<br><select data-f="scope" data-initial="${esc(req.scope)}">${(["in", "deferred", "excluded"] as const).map((s) => `<option value="${s}"${s === req.scope ? " selected" : ""}>${{ in: "In scope", deferred: "Deferred", excluded: "Out of scope" }[s]}</option>`).join("")}</select></label></div>
<div class="grow"><label class="meta">Scope note<br><input type="text" data-f="scopeNote" data-initial="${esc(req.scopeNote ?? "")}" value="${esc(req.scopeNote ?? "")}"></label></div></div>
<h3>Acceptance criteria <button type="button" data-accept-card>Accept all in this requirement</button></h3>
${criteria || `<p class="muted">No acceptance criteria yet.</p>`}
<label class="meta">Add criteria (one per line)<textarea data-f="add-ac"></textarea></label>
<label class="meta">Comment on the requirement<input type="text" data-f="comment"></label>
</section>`;
    })
    .join("");
  const body = `${staleBanner(state, "requirements_review")}
<div class="card"><div class="row"><div class="grow kv"><span class="muted">In scope</span><span>${progress.requirements} requirement(s), ${progress.criteria} criteria</span><span class="muted">Accepted</span><span>${progress.accepted}</span><span class="muted">Rejected</span><span>${progress.rejected}</span><span class="muted">Undecided</span><span>${progress.pending}</span><span class="muted">Deferred / out</span><span>${progress.deferred} / ${progress.excluded}</span></div>
<div><button id="btn-accept-all" type="button">Accept every criterion</button></div></div></div>
${cards || `<p class="muted">No requirements yet.</p>`}`;
  return shell(state, "requirements", "Requirements review", body, {}, options, `<label class="marks"><input type="checkbox" id="accept-all"> Mark the review complete (accept everything still undecided)</label>`);
}

// --- prototype ---------------------------------------------------------------------------------------------------

const COLOR_OK = /^[#\w(),.%\s/-]{1,60}$/;

export function renderPrototypeReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const proto = state.prototype;
  if (!proto) {
    return shell(state, "prototype", "Prototype review", `<p class="muted">There is no prototype yet. Ask Claude to build one from the accepted requirements.</p>`, {}, options, "");
  }
  const vars = [
    ...Object.entries(proto.styles.colors).filter(([, v]) => COLOR_OK.test(v)).map(([k, v]) => `--p-${k.replace(/[^\w-]/g, "")}:${v}`),
    ...(proto.styles.fonts.body && COLOR_OK.test(proto.styles.fonts.body.replace(/['"]/g, "")) ? [`--p-font:${proto.styles.fonts.body}`] : []),
    ...(proto.styles.radius && COLOR_OK.test(proto.styles.radius) ? [`--p-radius:${proto.styles.radius}`] : []),
  ].join(";");
  const tokenNote = proto.styles.sources.length > 0 ? `Styles read from ${proto.styles.sources.map((s) => esc(s.file)).join(", ")}.` : "Neutral styles: no application styles were found, so the look is generic.";
  const traceRows = [
    ...proto.screens.flatMap((s) => s.elements.filter((e) => e.requirementIds.length || e.acIds.length).map((e) => `<tr><td>${esc(s.id)}#${esc(e.id)}</td><td>${esc(e.label || e.kind)}</td><td>${esc([...e.requirementIds, ...e.acIds].join(", "))}</td></tr>`)),
    ...proto.endpoints.map((e) => `<tr><td>${esc(e.method)} ${esc(e.path)}</td><td>${esc(e.summary)}</td><td>${esc([...e.requirementIds, ...e.acIds].join(", "))}</td></tr>`),
  ].join("");
  const viewer =
    proto.kind === "ui"
      ? `<div class="proto" style="${esc(vars)}"><div class="nav" id="proto-nav" role="tablist">${proto.screens.map((s) => `<button type="button" role="tab" data-screen="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>
<div class="row" style="padding:8px"><label class="meta">State <select id="proto-state"></select></label>${proto.roles.length ? `<label class="meta">Role <select id="proto-role">${proto.roles.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>` : ""}<button id="proto-reset" type="button">Reset mock data</button></div>
<div class="screen" id="proto-screen"></div></div>
<p class="meta">Mock data only: nothing here talks to a real system. ${tokenNote}</p>`
      : `<p class="meta">Technical prototype of an API: request and response examples, no screens.</p>${proto.endpoints
          .map(
            (e) => `<div class="card"><h2>${pill(e.method)} ${esc(e.path)}</h2><p>${esc(e.summary)}</p><div class="meta">${e.auth ? `Auth: ${esc(e.auth)} · ` : ""}${esc([...e.requirementIds, ...e.acIds].join(" "))}</div>
${e.request !== undefined ? `<h3>Request</h3><pre>${esc(JSON.stringify(e.request, null, 2))}</pre>` : ""}${e.responses.map((r) => `<h3>Response ${r.status} ${esc(r.description)}</h3>${r.example !== undefined ? `<pre>${esc(JSON.stringify(r.example, null, 2))}</pre>` : ""}`).join("")}</div>`,
          )
          .join("")}`;
  const feedback = proto.feedback
    .map((f) => `<div class="card"><div class="row"><label class="marks"><input type="checkbox" data-resolve="${esc(f.id)}"${f.resolved ? " checked disabled" : ""}> ${f.resolved ? "Resolved" : "Mark resolved"}</label><span class="meta">${esc(f.target)} · ${esc(f.at)}</span></div><p>${esc(f.comment)}</p></div>`)
    .join("");
  const body = `${staleBanner(state, "prototype")}
<p>${pill(`${proto.kind === "ui" ? "UI" : "API"} prototype`)} ${pill(`revision ${proto.revision}`)} ${pill(proto.status, proto.status === "accepted" ? "ok" : "warn")}</p>
${proto.notes ? `<p>${esc(proto.notes)}</p>` : ""}
${viewer}
<h2 style="margin-top:18px">Your comments</h2><div id="fb-list"></div><button id="fb-add" type="button">Add a comment</button>
${feedback ? `<h3>Earlier comments</h3>${feedback}` : ""}
<h2 style="margin-top:18px">What it covers</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>${traceRows || `<tr><td class="muted">Nothing is linked to requirements yet.</td></tr>`}</tbody></table>`;
  const clientData = {
    proto: {
      kind: proto.kind,
      startScreen: proto.startScreen,
      roles: proto.roles,
      screens: proto.screens,
      mock: proto.mock,
    },
  };
  return shell(state, "prototype", "Prototype review", body, clientData, options, `<label class="marks"><input type="checkbox" id="accept-proto"> Accept this prototype</label>`);
}

// --- story plan --------------------------------------------------------------------------------------------------

export function renderStoryPlanReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const plan = state.storyPlan;
  if (!plan) return shell(state, "story-plan", "Story plan review", `<p class="muted">There is no story plan yet.</p>`, {}, options, "");
  const coverage = analyzeStoryCoverage(state);
  const cards = plan.entries
    .map((e) => {
      const out = e.status === "excluded";
      return `<section class="card${out ? " out" : ""}" data-entry="${esc(e.id)}" data-initial-status="${esc(e.review.status)}">
<div class="row"><h2 class="grow">${esc(e.id)} ${pill(e.status, out ? "warn" : e.status === "detailed" ? "ok" : "")}</h2>${marks(`m-${e.id}`, e.review.status)}</div>
<label class="meta">Title<input type="text" data-f="title" data-initial="${esc(e.title)}" value="${esc(e.title)}"></label>
<label class="meta">What is implemented<textarea data-f="implementation" data-initial="${esc(e.implementation)}">${esc(e.implementation)}</textarea></label>
<label class="meta">What the user gets<textarea data-f="userGets" data-initial="${esc(e.userGets)}">${esc(e.userGets)}</textarea></label>
<div class="kv" style="margin-top:6px"><span class="muted">Requirements</span><span>${esc(e.requirementIds.join(", "))}</span>
<span class="muted">Criteria</span><span>${esc(e.acIds.join(", ") || "-")}</span>
<span class="muted">Prototype</span><span>${esc(e.screenRefs.join(", ") || "-")}</span>
<span class="muted">Data</span><span>${esc(e.data.join(", ") || "-")}</span>
<span class="muted">Repositories / services</span><span>${esc([...e.repositoryIds, ...e.serviceIds].join(", ") || "-")}</span>
<span class="muted">Depends on</span><span>${esc(e.dependsOn.join(", ") || "-")}</span>
<span class="muted">Covers</span><span>${esc(e.capabilities.join(", ") || "-")}</span></div>
${out ? `<p class="meta">Excluded: ${esc(e.excludedReason ?? "")}</p><label class="marks"><input type="checkbox" data-f="restore"> Restore this story</label>` : `<label class="meta">Exclude from scope (reason)<input type="text" data-f="exclude"></label>`}
<label class="meta">Comment<input type="text" data-f="comment" value="${esc(e.review.comment ?? "")}"></label></section>`;
    })
    .join("");
  const gaps = coverage.gaps.map((g) => `<li>${esc(g.requirementId)}: ${esc(g.reason)}</li>`).join("");
  const body = `${staleBanner(state, "story_plan")}
<p>${pill(`revision ${plan.revision}`)} ${pill(plan.status, plan.status === "agreed" ? "ok" : "warn")} ${pill(`${plan.entries.length} planned stories`)}</p>
${gaps ? `<div class="stale"><strong>Possible gaps</strong><ul>${gaps}</ul></div>` : ""}
${cards}`;
  return shell(state, "story-plan", "Story plan review", body, {}, options, `<label class="marks"><input type="checkbox" id="agree-plan"> Agree this plan</label>`);
}

// --- stories -----------------------------------------------------------------------------------------------------

export function renderStoriesReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const stories = state.stories.filter((s) => s.status !== "superseded");
  const progress = storyReviewProgress(state);
  const cards = stories
    .map((story) => {
      const out = story.status === "excluded";
      const row = (key: string, label: string, text: string) => {
        const current = story.review[key]?.status ?? "pending";
        return `<div class="ac" data-key="${esc(key)}" data-initial-status="${esc(current)}"><div class="meta">${esc(label)}</div><div>${esc(text)}<div class="row">${marks(`m-${story.id}-${key}`, current)}<input type="text" data-f="comment" placeholder="Comment" value="${esc(story.review[key]?.comment ?? "")}" aria-label="Comment on ${esc(label)}" style="flex:1;min-width:140px"></div></div></div>`;
      };
      const items = out
        ? ""
        : [
            ...story.acceptanceCriteria.map((c) => row(`ac:${c.id}`, `AC ${c.id}`, `Given ${c.given}; when ${c.when}; then ${c.then}`)),
            ...story.happyPath.map((t, i) => row(`step:${i}`, `Step ${i + 1}`, t)),
            ...story.alternatives.map((t, i) => row(`alt:${i}`, `Alternative ${i + 1}`, t)),
            ...story.negative.map((t, i) => row(`neg:${i}`, `Negative ${i + 1}`, t)),
            ...story.edgeCases.map((t, i) => row(`edge:${i}`, `Edge case ${i + 1}`, t)),
            ...story.businessRules.map((t, i) => row(`rule:${i}`, `Rule ${i + 1}`, t)),
            ...story.expectedResults.map((t, i) => row(`result:${i}`, `Result ${i + 1}`, t)),
          ].join("");
      return `<section class="card${out ? " out" : ""}" data-story="${esc(story.id)}" data-rev="${story.revision}">
<div class="row"><h2 class="grow">${esc(story.id)} ${esc(story.title ?? "")} ${pill(`r${story.revision}`)} ${pill(story.status, out ? "warn" : story.status === "confirmed" ? "ok" : "")}${story.stale ? " " + pill("stale", "bad") : ""}</h2>${out ? "" : `<label class="marks"><input type="checkbox" data-f="accept-story"> Accept everything in this story</label>`}</div>
<p class="meta">${esc(story.requirementIds.join(", "))}${story.screenRefs.length ? " · prototype: " + esc(story.screenRefs.join(", ")) : ""}${story.repositoryIds.length ? " · repos: " + esc(story.repositoryIds.join(", ")) : ""}</p>
<label class="meta">Story<textarea data-f="narrative" data-initial="${esc(story.narrative)}">${esc(story.narrative)}</textarea></label>
<label class="meta">Objective<textarea data-f="objective" data-initial="${esc(story.objective)}">${esc(story.objective)}</textarea></label>
${story.preconditions.length ? `<p class="meta">Preconditions: ${esc(story.preconditions.join("; "))}</p>` : ""}
${items}
${out ? `<p class="meta">Excluded: ${esc(story.excludedReason ?? "")}</p><label class="marks"><input type="checkbox" data-f="restore"> Restore this story</label>` : `<label class="meta">Exclude this story (reason)<input type="text" data-f="exclude"></label>`}
</section>`;
    })
    .join("");
  const body = `${staleBanner(state, "stories_review")}
<div class="card"><div class="kv"><span class="muted">Stories</span><span>${progress.stories}</span><span class="muted">Items</span><span>${progress.items}</span><span class="muted">Accepted</span><span>${progress.accepted}</span><span class="muted">Rejected</span><span>${progress.rejected}</span><span class="muted">Undecided</span><span>${progress.pending}</span></div>
<p class="meta">Editing a story creates a new revision. Items you did not change keep their marks; an item whose text changed starts over, and so does the story's confirmation.</p></div>
${cards || `<p class="muted">No stories yet.</p>`}`;
  return shell(state, "stories", "User stories review", body, {}, options, `<label class="marks"><input type="checkbox" id="accept-stories"> Accept the stories</label>`);
}

// --- contracts ---------------------------------------------------------------------------------------------------

export function renderContractsReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const cards = state.contracts
    .map((c) => {
      const agreed = c.status === "agreed";
      return `<section class="card" data-contract="${esc(c.id)}">
<div class="row"><h2 class="grow">${esc(c.id)} ${esc(c.name)} ${pill(c.status, agreed ? "ok" : "warn")}</h2>${agreed ? `<label class="marks"><input type="checkbox" data-f="remove"> Remove</label><span class="meta">agreed ${esc(c.agreement?.at ?? "")}${c.agreement ? " (" + esc(c.agreement.via) + ")" : ""}</span>` : `<label class="marks"><input type="checkbox" data-f="agree"> I agree this contract</label>`}</div>
<p>${esc(c.description)}</p>
<div class="kv"><span class="muted">Provider</span><span>${esc(c.providerServiceId)}</span><span class="muted">Consumers</span><span>${esc(c.consumerServiceIds.join(", ") || "-")}</span><span class="muted">Schema</span><span>${esc(c.schemaRef ?? "-")}</span><span class="muted">Requirements</span><span>${esc(c.requirementIds.join(", ") || "-")}</span><span class="muted">Stories</span><span>${esc(c.storyIds.join(", ") || "-")}</span></div>
${agreed ? "" : `<p class="meta">Agreeing lets implementation start in the services that use it. Changing the contract afterwards makes it proposed again.</p>`}</section>`;
    })
    .join("");
  return shell(state, "contracts", "Contracts review", `<p class="meta">A contract is what services promise each other. The architect proposes it; only you agree it.</p>${cards || `<p class="muted">There are no contracts yet.</p>`}`, {}, options, "");
}

export function renderReview(state: WorkflowState, view: ReviewView, options: RenderReviewOptions = {}): string {
  switch (view) {
    case "requirements":
      return renderRequirementsReview(state, options);
    case "prototype":
      return renderPrototypeReview(state, options);
    case "story-plan":
      return renderStoryPlanReview(state, options);
    case "contracts":
      return renderContractsReview(state, options);
    default:
      return renderStoriesReview(state, options);
  }
}
