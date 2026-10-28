import { esc, jsonForScript, pill } from "./review-util.js";
import { PROTOTYPE_CSS, PROTOTYPE_SCRIPT, renderPrototypeBody } from "./prototype-viewer.js";
import { fingerprintFor, planEntryBase, reviewStamp, workStateStamp, type ReviewView } from "./review-submission.js";
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

export { esc };

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
${PROTOTYPE_CSS}
:root[data-theme=dark]{--bg:#14171f;--fg:#e6e9f0;--muted:#9aa3b5;--line:#2c3242;--card:#1c202b;--accent:#7aa2ff;--ok:#5ad08a;--bad:#ff8a80;--warn:#ffc266;--okbg:#14301f;--badbg:#3a1a18;--on-accent:#0b1020}
.card.summary{position:sticky;top:0;z-index:4}
.bigcount{font-size:15px;margin-bottom:6px}
.pbar{display:flex;height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:4px 0 6px}.pbar .a{background:var(--ok)}.pbar .r{background:var(--bad)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 9px;color:var(--fg);text-decoration:none;background:var(--bg)}
.chip.accepted{border-color:var(--ok);color:var(--ok)}.chip.out{color:var(--muted)}.chip.open{border-color:var(--warn)}
.grouph{font-size:15px;margin:22px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card.req{padding:14px 16px;scroll-margin-top:150px}
.reqhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}.reqhead h2{font-size:16px}.rid{font-family:ui-monospace,Menlo,monospace}
textarea.auto{overflow:hidden;line-height:1.55;min-height:28px}
textarea.reqtext{font-size:16px;font-weight:500;margin:6px 0 8px;border-color:transparent;background:transparent;padding:4px 0}
textarea.reqtext:hover,textarea.reqtext:focus{border-color:var(--line);background:var(--bg);padding:4px 8px}
.scoperow{margin-bottom:6px}.scoperow select{width:auto}
.achead{display:flex;justify-content:space-between;align-items:center;margin-top:10px}.achead h3{margin:0}.achead button{font-size:12px;padding:2px 8px}
.ac{display:grid;grid-template-columns:52px 1fr;gap:4px 10px;padding:10px 0;border-top:1px solid var(--line)}
.acid{font-size:12px;color:var(--muted);padding-top:6px}
.acbody textarea.auto{border-color:transparent;background:transparent;padding:4px 0;min-height:0}
.acbody textarea.auto:hover,.acbody textarea.auto:focus{border-color:var(--line);background:var(--bg);padding:4px 8px}
.acctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
.acctl input[type=text]{flex:1;min-width:140px;font-size:13px;padding:3px 8px}
.acctl .rm{font-size:12px;color:var(--muted);display:flex;gap:4px;align-items:center;cursor:pointer}
.prev{font-size:12px;color:var(--warn);background:var(--card);border-left:3px solid var(--warn);padding:2px 8px;margin:2px 0}
.marks.tri{display:inline-flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
.marks.tri label{position:relative;gap:0;margin:0}.marks.tri label+label{border-left:1px solid var(--line)}
.marks.tri input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.marks.tri span{display:block;padding:3px 10px;font-size:13px}
.marks.tri label:has(input:checked).m-accepted span{background:var(--ok);color:#fff}.marks.tri label:has(input:checked).m-rejected span{background:var(--bad);color:#fff}.marks.tri label:has(input:checked).m-pending span{background:var(--card);font-weight:600}
.marks.tri label:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:1px}
.addrow{margin-top:8px}.addrow textarea{min-height:34px}
@media (max-width:560px){.ac{grid-template-columns:1fr}.bar button{padding:4px 8px;font-size:13px}.card.summary{position:static}}
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
  var s={contract:'praxis.review.submission',version:1,reviewId:D.reviewId,view:D.view,workItemId:D.workItemId,baseFingerprint:D.baseFingerprint,baseStamp:D.baseStamp,baseState:D.baseState,submittedAt:new Date().toISOString()};
  if(D.view==='requirements'){
    var reqs=[];
    $$('[data-req]').forEach(function(card){
      var id=card.getAttribute('data-req');var item={id:id,revision:num(card),criteria:[],addCriteria:[],removeCriteria:[]};var touched=false;
      var st=$('[data-f=statement]',card);if(st&&val(st)!==(st.getAttribute('data-initial')||'').trim()){item.statement=val(st);touched=true}
      var sc=$('[data-f=scope]',card);if(sc&&sc.value!==(sc.getAttribute('data-initial')||'').trim()){item.scope=sc.value;item.fromScope=(sc.getAttribute('data-initial')||'').trim();touched=true}
      var sn=$('[data-f=scopeNote]',card);if(sn&&val(sn)!==(sn.getAttribute('data-initial')||'').trim()){item.scopeNote=val(sn);item.fromScopeNote=(sn.getAttribute('data-initial')||'').trim();touched=true}
      var rc=$('[data-f=comment]',card);if(rc&&val(rc)!==(rc.getAttribute('data-initial')||'').trim()){item.comment=val(rc);item.fromComment=(rc.getAttribute('data-initial')||'').trim();touched=true}
      $$('[data-ac]',card).forEach(function(row){
        var aid=row.getAttribute('data-ac');
        if($('[data-f=remove]',row)&&$('[data-f=remove]',row).checked){item.removeCriteria.push(aid);touched=true;return}
        var c={id:aid,revision:num(row)};var ch=false;
        var m=markOf(row,'m-'+aid);if(m&&m!==row.getAttribute('data-initial-status')){c.status=m;c.from=row.getAttribute('data-initial-status');ch=true}
        var cm=$('[data-f=ac-comment]',row);if(cm&&val(cm)!==(cm.getAttribute('data-initial')||'').trim()){c.comment=val(cm);c.fromComment=cm.getAttribute('data-initial')||'';ch=true}
        var ts=$('[data-f=ac-statement]',row);if(ts&&val(ts)!==(ts.getAttribute('data-initial')||'').trim()){c.statement=val(ts);ch=true}
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
      var id=card.getAttribute('data-entry');var e={id:id,base:card.getAttribute('data-base')};var ch=false;
      var m=markOf(card,'m-'+id);if(m&&m!==card.getAttribute('data-initial-status')){e.status=m;ch=true}
      var cm=$('[data-f=comment]',card);if(cm&&val(cm)){e.comment=val(cm);ch=true}
      ['title','implementation','userGets'].forEach(function(f){var t=$('[data-f='+f+']',card);if(t&&val(t)!==(t.getAttribute('data-initial')||'').trim()){e[f]=val(t);ch=true}});
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
        if(m&&(m!==row.getAttribute('data-initial-status')||(cm&&val(cm)))){var it={storyId:id,revision:rev,key:key,from:row.getAttribute('data-initial-status'),status:m};if(cm&&val(cm)){it.comment=val(cm);it.fromComment=(cm.getAttribute('data-initial')||'').trim()}items.push(it)}
      });
      var n=$('[data-f=narrative]',card);if(n&&val(n)!==(n.getAttribute('data-initial')||'').trim()){st.narrative=val(n);ch=true}
      var o=$('[data-f=objective]',card);if(o&&val(o)!==(o.getAttribute('data-initial')||'').trim()){st.objective=val(o);ch=true}
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
function fit(t){t.style.height='auto';t.style.height=(t.scrollHeight+2)+'px'}
$$('textarea.auto').forEach(function(t){fit(t);t.addEventListener('input',function(){fit(t)})});
${PROTOTYPE_SCRIPT}
})();
`;

function shell(state: WorkflowState, view: ReviewView, title: string, body: string, data: Record<string, unknown>, options: RenderReviewOptions, barExtra: string, wide = false): string {
  const payload = {
    reviewId: options.reviewId ?? `${view}-${state.workItem.id}`,
    view,
    workItemId: state.workItem.id,
    baseFingerprint: fingerprintFor(state, view),
    baseStamp: reviewStamp(state, view),
    baseState: workStateStamp(state),
    saveUrl: options.saveUrl,
    token: options.token,
    ...data,
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main${wide ? ' class="wide"' : ""}>
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
  return `<div class="marks tri" role="radiogroup">${(["accepted", "rejected", "pending"] as const)
    .map((v) => `<label class="m-${v}"><input type="radio" name="${esc(name)}" value="${v}"${v === current ? " checked" : ""}><span>${labels[v]}</span></label>`)
    .join("")}</div>`;
}


function staleBanner(state: WorkflowState, phase: "requirements_review" | "prototype" | "story_plan" | "stories_review"): string {
  return acceptanceStatus(state, phase) === "stale" ? `<div class="stale"><strong>Changed since you accepted it.</strong> The earlier acceptance no longer applies; review the changes and accept again.</div>` : "";
}

// --- requirements ------------------------------------------------------------------------------------------------

export function renderRequirementsReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const all = state.requirements.filter((r) => r.status !== "superseded");
  const progress = reviewProgress(state);
  const decided = progress.accepted + progress.rejected;
  const pct = (n: number) => (progress.criteria ? Math.round((n / progress.criteria) * 100) : 0);
  const reqState = (req: (typeof all)[number]) => (req.scope !== "in" ? "out" : req.acceptanceCriteria.length > 0 && req.acceptanceCriteria.every((c) => c.review.status === "accepted") ? "accepted" : "open");
  const card = (req: (typeof all)[number]) => {
    const out = req.scope !== "in";
    const accepted = req.acceptanceCriteria.filter((c) => c.review.status === "accepted").length;
    const criteria = req.acceptanceCriteria
      .map((ac) => {
        const prev = ac.review.previous && ac.review.status === "pending" ? ac.review.previous : null;
        return `<div class="ac" data-ac="${esc(ac.id)}" data-rev="${ac.revision}" data-initial-status="${esc(ac.review.status)}">
<div class="acid"><strong>${esc(ac.id.replace(/^.*-AC-/, "AC-"))}</strong>${ac.revision > 1 ? `<br>${pill(`r${ac.revision}`, "warn")}` : ""}</div>
<div class="acbody"><textarea class="auto" data-f="ac-statement" data-initial="${esc(ac.statement)}" aria-label="Text of ${esc(ac.id)}">${esc(ac.statement)}</textarea>${prev ? `\n<div class="prev" data-previous>Before this revision: <strong>${esc(prev.status)}</strong>${prev.comment ? ` - "${esc(prev.comment)}"` : ""} (the text changed, so it needs a new decision)</div>` : ""}
<div class="acctl">${marks(`m-${ac.id}`, ac.review.status)}<input type="text" data-f="ac-comment" data-initial="${esc(ac.review.comment ?? "")}" placeholder="Comment" value="${esc(ac.review.comment ?? "")}" aria-label="Comment on ${esc(ac.id)}"><label class="rm"><input type="checkbox" data-f="remove"> Remove</label></div></div></div>`;
      })
      .join("");
    return `<section class="card req${out ? " out" : ""}" id="req-${esc(req.id)}" data-req="${esc(req.id)}" data-rev="${req.revision}">
<div class="reqhead"><h2><span class="rid">${esc(req.id)}</span> ${pill(`r${req.revision}`)} ${pill(req.status)}${out ? " " + pill(req.scope, "warn") : ""}</h2><span class="meta">${accepted} of ${req.acceptanceCriteria.length} criteria accepted</span></div>
<textarea class="auto reqtext" data-f="statement" data-initial="${esc(req.statement)}" aria-label="Statement of ${esc(req.id)}">${esc(req.statement)}</textarea>
<div class="row scoperow"><label class="meta">Scope<select data-f="scope" data-initial="${esc(req.scope)}">${(["in", "deferred", "excluded"] as const).map((sc) => `<option value="${sc}"${sc === req.scope ? " selected" : ""}>${{ in: "In scope", deferred: "Deferred", excluded: "Out of scope" }[sc]}</option>`).join("")}</select></label>
<label class="meta grow">Scope note<input type="text" data-f="scopeNote" data-initial="${esc(req.scopeNote ?? "")}" value="${esc(req.scopeNote ?? "")}"></label></div>
<div class="achead"><h3>Acceptance criteria</h3><button type="button" data-accept-card>Accept all in this requirement</button></div>
${criteria || `<p class="muted">No acceptance criteria yet.</p>`}
<div class="row addrow"><label class="meta grow">Add criteria (one per line)<textarea data-f="add-ac"></textarea></label>
<label class="meta grow">Comment on the requirement<input type="text" data-f="comment" data-initial="${esc(req.comment ?? "")}" value="${esc(req.comment ?? "")}"></label></div>
</section>`;
  };
  const groups: Array<[string, string, typeof all]> = [
    ["open", "Needs your decision", all.filter((r) => reqState(r) === "open")],
    ["accepted", "Accepted", all.filter((r) => reqState(r) === "accepted")],
    ["out", "Deferred or out of scope", all.filter((r) => reqState(r) === "out")],
  ];
  const sections = groups.filter(([, , list]) => list.length).map(([, title, list]) => `<h2 class="grouph">${esc(title)} <span class="meta">${list.length}</span></h2>${list.map(card).join("")}`).join("");
  const chips = all.map((r) => `<a class="chip ${reqState(r)}" href="#req-${esc(r.id)}">${esc(r.id)}</a>`).join("");
  const body = `${staleBanner(state, "requirements_review")}
<div class="card summary"><div class="row" style="align-items:center"><div class="grow"><div class="bigcount"><strong>${decided}</strong> of ${progress.criteria} criteria decided</div>
<div class="pbar" role="img" aria-label="${progress.accepted} accepted, ${progress.rejected} rejected, ${progress.pending} undecided"><span class="a" style="width:${pct(progress.accepted)}%"></span><span class="r" style="width:${pct(progress.rejected)}%"></span></div>
<div class="meta">${progress.accepted} accepted · ${progress.rejected} rejected · ${progress.pending} undecided · ${progress.requirements} requirement(s) in scope · deferred / out ${progress.deferred} / ${progress.excluded}</div></div>
<div><button id="btn-accept-all" type="button">Accept every criterion</button></div></div>
${chips ? `<nav class="chips" aria-label="Requirements">${chips}</nav>` : ""}</div>
${sections || `<p class="muted">No requirements yet.</p>`}`;
  return shell(state, "requirements", "Requirements review", body, {}, options, `<label class="marks"><input type="checkbox" id="accept-all"> Mark the review complete (accept everything still undecided)</label>`);
}

// --- prototype ---------------------------------------------------------------------------------------------------

export function renderPrototypeReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const proto = state.prototype;
  if (!proto) {
    return shell(state, "prototype", "Prototype review", `<p class="muted">There is no prototype yet. Ask Claude to build one from the accepted requirements.</p>`, {}, options, "");
  }
  const { body, clientData } = renderPrototypeBody(state, proto, staleBanner(state, "prototype"));
  return shell(state, "prototype", "Prototype review", body, clientData, options, `<label class="marks"><input type="checkbox" id="accept-proto"> Accept this prototype</label>`, proto.kind === "ui");
}

// --- story plan --------------------------------------------------------------------------------------------------

export function renderStoryPlanReview(state: WorkflowState, options: RenderReviewOptions = {}): string {
  const plan = state.storyPlan;
  if (!plan) return shell(state, "story-plan", "Story plan review", `<p class="muted">There is no story plan yet.</p>`, {}, options, "");
  const coverage = analyzeStoryCoverage(state);
  const cards = plan.entries
    .map((e) => {
      const out = e.status === "excluded";
      return `<section class="card${out ? " out" : ""}" data-entry="${esc(e.id)}" data-initial-status="${esc(e.review.status)}" data-base="${planEntryBase(e)}">
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
