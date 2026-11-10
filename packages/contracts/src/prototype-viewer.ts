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
.proto[data-mode=inspect] .screen .el,.proto[data-mode=review] .screen .el{margin-top:calc(var(--pc-s)*3.2)}
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
.proto .cv{border:1px solid var(--pc-border);border-radius:var(--pc-r);background:var(--pc-surface);overflow:hidden}
.proto .cv-feed{height:clamp(320px,62vh,620px);overflow-y:auto;overscroll-behavior:contain;padding:calc(var(--pc-s)*.5) calc(var(--pc-s)*1.5) calc(var(--pc-s)*1.5)}
.proto .cv-feed>.state-msg{margin-top:calc(var(--pc-s)*2)}
.proto .cv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}
.proto .cv-day{align-self:center;margin:calc(var(--pc-s)*1.5) 0 calc(var(--pc-s)*.5);padding:2px 12px;border-radius:999px;background:var(--pc-bg);border:1px solid var(--pc-border);font-size:12px;color:var(--pc-muted)}
.proto .cv-msg{display:flex;gap:8px;align-items:flex-end;max-width:min(68%,580px)}
.proto .cv-msg.in{align-self:flex-start}.proto .cv-msg.out{align-self:flex-end;flex-direction:row-reverse}
.proto .cv-msg.first{margin-top:calc(var(--pc-s)*.75)}
.proto .cv-av{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;background:var(--av,#5b6475)}
.proto .cv-msg:not(.first) .cv-av{visibility:hidden}.proto .cv-msg.out .cv-av{display:none}
.proto .cv-b{min-width:0;padding:6px 11px 5px;border-radius:calc(var(--pc-r) + 4px);background:var(--pc-bg);border:1px solid var(--pc-border);box-shadow:0 1px 1px rgba(0,0,0,.05);overflow-wrap:anywhere}
.proto .cv-msg.in .cv-b{border-bottom-left-radius:4px}
.proto .cv-msg.out .cv-b{background:color-mix(in srgb,var(--pc-primary) 13%,var(--pc-bg));border-color:color-mix(in srgb,var(--pc-primary) 32%,var(--pc-bg));border-bottom-right-radius:4px}
.proto .cv-who{font-size:12px;font-weight:700;margin:0 0 2px;color:var(--pc-primary)}.proto .cv-msg.out .cv-who{text-align:right;color:var(--pc-muted)}
.proto .cv-text{white-space:pre-wrap}
.proto .cv-foot{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--pc-muted);margin-top:2px}
.proto .cv-tag{border:1px solid var(--pc-border);border-radius:999px;padding:0 6px}
.proto .cv-msg[tabindex]{cursor:pointer}.proto .cv-msg[tabindex]:hover .cv-b{border-color:var(--pc-primary)}.proto .cv-msg[aria-current=true] .cv-b{outline:2px solid var(--pc-primary);outline-offset:1px}
.proto .cv-voice{display:flex;align-items:center;gap:8px;min-width:200px;margin:2px 0}
.proto .cv-play{flex:none;width:32px;height:32px;border-radius:50%;border:0;padding:0;background:var(--pc-primary);color:var(--pc-on-primary);font-size:12px;cursor:pointer}
.proto .cv-wave{position:relative;flex:0 1 150px;min-width:60px;height:24px;display:flex;align-items:center;justify-content:space-between;overflow:hidden}
.proto .cv-wave i{flex:none;width:3px;border-radius:2px;background:color-mix(in srgb,var(--pc-text) 28%,transparent)}
.proto .cv-wave::after{content:"";position:absolute;left:0;top:0;bottom:0;width:0;border-radius:3px;background:color-mix(in srgb,var(--pc-primary) 34%,transparent)}
.proto .cv-voice[data-playing] .cv-wave::after{animation:pvvoice var(--dur,10s) linear forwards}
@keyframes pvvoice{to{width:100%}}
.proto .cv-dur{flex:none;white-space:nowrap;font-size:12px;color:var(--pc-muted);font-variant-numeric:tabular-nums}.proto .cv-mock{font-size:11px;color:var(--pc-muted);font-style:italic}
.proto .cv-att{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px}
.proto .cv-photo{margin:0;width:136px;border:1px solid var(--pc-border);border-radius:8px;overflow:hidden;background:var(--pc-bg);font-size:11px}
.proto .cv-photo .ph{height:84px;display:grid;place-items:center;color:var(--pc-muted);background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--pc-primary) 10%,var(--pc-bg)) 0 10px,color-mix(in srgb,var(--pc-primary) 18%,var(--pc-bg)) 10px 20px)}
.proto .cv-photo figcaption{padding:3px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.proto .cv-doc{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--pc-border);border-radius:8px;background:var(--pc-bg);max-width:270px;font-size:12px}
.proto .cv-doc .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.proto .cv-doc .sz{display:block;font-size:11px;color:var(--pc-muted)}
.proto .cv-ext{flex:none;font-size:10px;font-weight:800;padding:6px 5px;border-radius:4px;background:var(--pc-danger);color:#fff}
.proto .cv-compose{display:flex;gap:var(--pc-s);padding:var(--pc-s);border-top:1px solid var(--pc-border);background:var(--pc-bg)}.proto .cv-compose input{flex:1;min-width:0}
@container proto (max-width:620px){.proto .cv-msg{max-width:94%}.proto .cv-feed{height:clamp(300px,60vh,560px);padding:4px 8px 10px}.proto .cv-photo{width:112px}.proto .cv-compose input{width:auto}}
.proto iframe.pv-custom{display:block;width:100%;border:1px solid var(--pc-border);border-radius:0 0 var(--pc-r) var(--pc-r);background:var(--pc-bg)}
.proto .pv-custom-cap{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:3px 10px;border:1px solid var(--pc-border);border-bottom:0;border-radius:var(--pc-r) var(--pc-r) 0 0;background:var(--pc-surface);font-size:11px;color:var(--pc-muted)}
.proto .pv-custom-cap strong{color:var(--pc-text)}.proto .pv-custom-cap .stolen{color:var(--pc-danger)}
.proto[data-mode=inspect] .screen iframe.pv-custom,.proto[data-mode=review] .screen iframe.pv-custom{pointer-events:auto}
`;

/**
 * The sandboxed frame of a custom element. Its own policy comes first, so whatever the markup does, the frame has no network
 * (also in the offline copy, which has no server policy); the sandbox attribute gives it an opaque origin with no access to the page.
 */
export const CUSTOM_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const CUSTOM_FRAME_CSS = `:root{--pc-bg:var(--p-background,#fff);--pc-text:var(--p-text,#1d2330);--pc-primary:var(--p-primary,#2457d6);--pc-on-primary:var(--p-on-primary,#fff);--pc-danger:var(--p-danger,#b42318);--pc-surface:var(--p-surface,color-mix(in srgb,var(--pc-text) 4%,var(--pc-bg)));--pc-border:var(--p-border,color-mix(in srgb,var(--pc-text) 16%,var(--pc-bg)));--pc-muted:color-mix(in srgb,var(--pc-text) 62%,var(--pc-bg));--pc-r:var(--p-radius,8px);--pc-s:var(--p-space,8px)}
*{box-sizing:border-box}html,body{margin:0;background:var(--pc-bg);color:var(--pc-text);font:14px/1.45 var(--p-font,system-ui,-apple-system,"Segoe UI",sans-serif)}
html[data-praxis-mode=inspect] [data-praxis-part],html[data-praxis-mode=review] [data-praxis-part]{cursor:crosshair}
html[data-praxis-mode=inspect] [data-praxis-part]:hover,html[data-praxis-mode=review] [data-praxis-part]:hover{outline:2px dashed var(--pc-primary);outline-offset:2px}
[data-praxis-part].praxis-sel{outline:2px solid var(--pc-primary);outline-offset:2px}`;
/** Runs inside the frame before the part's own script: receives data and the mode, and in Inspect/Review reports which part was clicked. */
const CUSTOM_FRAME_BRIDGE = `(function(){var mode='preview',sel='';var P=window.praxis={data:null,mode:mode,onData:null};
function paint(){document.documentElement.setAttribute('data-praxis-mode',mode);Array.prototype.forEach.call(document.querySelectorAll('[data-praxis-part]'),function(n){n.classList.toggle('praxis-sel',n.getAttribute('data-praxis-part')===sel)})}
addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;if(!m||typeof m!=='object')return;
if(m.type==='praxis:data'||m.type==='praxis:mode'){mode=P.mode=String(m.mode||'preview');sel=String(m.selected||'');paint()}
if(m.type==='praxis:data'){P.data=m.data;try{if(typeof P.onData==='function')P.onData(m.data)}catch(err){console.error(err)}try{dispatchEvent(new CustomEvent('praxis:data',{detail:m.data}))}catch(err){}}});
document.addEventListener('click',function(e){if(mode==='preview')return;e.preventDefault();e.stopPropagation();var t=e.target&&e.target.closest?e.target.closest('[data-praxis-part]'):null;parent.postMessage({type:'praxis:pick',part:t?t.getAttribute('data-praxis-part'):''},'*')},true);
parent.postMessage({type:'praxis:ready'},'*')})();`;
/** Script text cannot close its own tag, so a part's "</script>" stays inside the frame's script. */
const scriptText = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1");
const styleText = (s: string) => s.replace(/<\/(style)/gi, "<\\/$1");

/** The whole document of a custom element's frame, built on the page from data (never inserted into the page itself). */
export function customFrameDocument(custom: { html: string; css: string; script: string }, vars: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CUSTOM_FRAME_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${vars}}${CUSTOM_FRAME_CSS}</style><style>${styleText(custom.css)}</style></head><body>${custom.html}<script>${CUSTOM_FRAME_BRIDGE}</script><script>${scriptText(custom.script)}</script></body></html>`;
}

export const PROTOTYPE_SCRIPT = String.raw`
// prototype viewer
if(D.view==='prototype'&&D.proto&&D.proto.kind==='ui'){(function(){
var P=D.proto;P.datasets=P.datasets||[];P.scenarios=P.scenarios||[];P.screens=P.screens||[];P.mock=P.mock||[];
var host=$('#proto-screen'),frame=$('#proto-frame'),urlIn=$('#proto-url'),device=$('#pv-device');
var startId=P.startScreen||(P.screens[0]&&P.screens[0].id);
var live={},search={},form={},formErr={},dsId='',role0=(P.roles&&P.roles[0])||'',role=role0,stateName='default',mode='preview',sel=null,cur=startId,q={},opened={},opener=null,results={},curScenario=null;
var drafts={},liveFrames={},pendingScroll=[],newSeq=0,FRAMES=D.frames||{};
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
// nothing matches (with the button that clears the filters) or there is no data at all
function emptyBlock(scr,el){var noData=!(live[el.collection]||[]).length;var em=emptyMsg(noData?(el.noDataText||'There is no data yet.'):(el.emptyText||'No rows').replace(/\{(\w[\w-]*)\}/g,function(m,p){return pv(p,scr)}));if(el.emptyAction&&!noData){var ab=h('button',{type:'button',class:'btn sec',style:'margin-top:8px','data-fk':'empty-action:'+scr.id+'#'+el.id},[el.emptyAction.label]);ab.addEventListener('click',function(){if(mode!=='preview')return;var n=clone(q);(el.emptyAction.clear||[]).forEach(function(k){delete n[k]});q=n;pushUrl(false);render()});em.appendChild(h('div',{},[ab]))}return em}
function rowTarget(scr,el){return el.rowOpens&&scr.elements.filter(function(x){return x.id===el.rowOpens})[0]}
function renderTable(scr,el){
  var box=h('div',{});var c=collDef(el.collection);
  if(!c){box.appendChild(emptyMsg('No data'));return box}
  var cols=el.columns&&el.columns.length?el.columns:c.fields.map(function(f){return f.key});
  var rows=rowsFor(el),id=idField(el),target=rowTarget(scr,el),openId=target&&target.param?q[target.param]:undefined;
  if(!rows.length){box.appendChild(emptyBlock(scr,el));box.appendChild(h('div',{class:'count','data-count':'0'},['0 of '+(live[el.collection]||[]).length]));return box}
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
// ---- conversation: rows as messages
var AV=['#2f6f9f','#7a4fa0','#9a5b2e','#2e7d6b','#86691c','#b03a5b','#4f6b2a'];
function blank(v){return v===null||v===undefined||v===''}
function initials(s){var p=String(s||'').trim().split(/\s+/).filter(Boolean);return (((p[0]||'?')[0]||'?')+((p[1]||'')[0]||'')).toUpperCase()}
function avColor(s){var x=0;s=String(s||'');for(var i=0;i<s.length;i++)x=(x*31+s.charCodeAt(i))|0;return AV[Math.abs(x)%AV.length]}
// wall-clock time as written: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", never shifted by a time zone
function tparse(v){var m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v===null||v===undefined?'':v));return m?{day:m[1]+'-'+m[2]+'-'+m[3],y:+m[1],mo:+m[2],d:+m[3],hm:m[4]?m[4]+':'+m[5]:'',min:Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0))/60000}:null}
function dayLabel(t,loc){try{return new Intl.DateTimeFormat(loc||undefined,{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(t.y,t.mo-1,t.d)))}catch(e){return t.day}}
function dur(s){s=Math.max(0,Math.round(Number(s)||0));return Math.floor(s/60)+':'+('0'+s%60).slice(-2)}
function nowStamp(){var d=new Date(),p=function(n){return ('0'+n).slice(-2)};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())}
function isOut(c,r){var f=c.outgoingField||c.authorField;return !blank(r[f])&&(c.outgoingValues||[]).indexOf(String(r[f]))>=0}
function voiceNode(sec){
  var w=h('div',{class:'cv-voice','data-voice':String(sec)});
  var b=h('button',{type:'button',class:'cv-play','aria-pressed':'false','aria-label':'Play voice message ('+dur(sec)+', mock: no audio)'},['\u25B6']);
  var wave=h('span',{class:'cv-wave','aria-hidden':'true',style:'--dur:'+Math.max(1,Math.round(sec))+'s'});
  for(var i=0;i<28;i++)wave.appendChild(h('i',{style:'height:'+(25+((i*37+11)%13)*5)+'%'}));
  var stop=function(){b.setAttribute('aria-pressed','false');b.textContent='\u25B6';w.removeAttribute('data-playing')};
  // the player is local to the message: no re-render, so the feed keeps its scroll position
  b.addEventListener('click',function(e){e.stopPropagation();if(mode!=='preview')return;if(b.getAttribute('aria-pressed')==='true'){stop();return}b.setAttribute('aria-pressed','true');b.textContent='\u275A\u275A';w.setAttribute('data-playing','')});
  b.addEventListener('keydown',function(e){e.stopPropagation()});
  wave.addEventListener('animationend',stop);
  w.appendChild(b);w.appendChild(wave);w.appendChild(h('span',{class:'cv-dur'},[dur(sec)]));
  return h('div',{},[w,h('div',{class:'cv-mock'},['Mock playback: no audio'])])
}
function attNode(a,x){
  var name=blank(x[a.nameField])?'':String(x[a.nameField]),type=a.typeField&&!blank(x[a.typeField])?String(x[a.typeField]):'',size=a.sizeField&&!blank(x[a.sizeField])?String(x[a.sizeField]):'';
  var photo=/photo|image|picture|img|\u0444\u043e\u0442\u043e|\u0438\u0437\u043e\u0431\u0440|\u043a\u0430\u0440\u0442\u0438\u043d/i.test(type)||(!type&&/\.(jpe?g|png|gif|webp|heic)$/i.test(name));
  if(photo)return h('figure',{class:'cv-photo','data-att':name,'data-att-kind':'photo'},[h('div',{class:'ph','aria-hidden':'true'},[type||'Photo']),h('figcaption',{},[name+(size?' \u00b7 '+size:'')])]);
  var ext=(/\.([A-Za-z0-9]{1,5})$/.exec(name)||[])[1];
  return h('div',{class:'cv-doc','data-att':name,'data-att-kind':'document'},[h('span',{class:'cv-ext','aria-hidden':'true'},[(ext||'file').toUpperCase()]),h('span',{style:'min-width:0'},[h('span',{class:'nm'},[name]),size||type?h('span',{class:'sz'},[[type,size].filter(Boolean).join(' \u00b7 ')]):null])])
}
function renderConversation(scr,el){
  var c=el.conversation||{},box=h('div',{class:'cv'}),key=scr.id+'#'+el.id;
  if(!collDef(el.collection)||!c.authorField)return emptyMsg('No data');
  var total=(live[el.collection]||[]).length,rows=rowsFor(el).map(function(r,i){return {r:r,i:i,t:tparse(r[c.timeField])}});
  // chronological; a message without a time keeps its place at the start; equal times keep the data order
  rows.sort(function(a,b){var x=a.t?a.t.min:-Infinity,y=b.t?b.t.min:-Infinity;return x===y?a.i-b.i:x-y});
  var id=idField(el),target=rowTarget(scr,el),openId=target&&target.param?q[target.param]:undefined,gap=c.groupMinutes===undefined?5:c.groupMinutes;
  var feed=h('div',{class:'cv-feed',tabindex:'0',role:'region','aria-label':(el.label||'Messages')+' ('+rows.length+')','data-feed':key});
  if(!rows.length)feed.appendChild(emptyBlock(scr,el));
  else{
    var list=h('ol',{class:'cv-list'}),prev=null,prevDay=null;
    rows.forEach(function(m){
      var r=m.r,t=m.t,day=t?t.day:'';
      if(day!==prevDay||prevDay===null){list.appendChild(h('li',{class:'cv-day','data-day':day},[t?dayLabel(t,c.locale):(el.missingText||'Date not provided')]));prevDay=day;prev=null}
      var author=blank(r[c.authorField])?'':String(r[c.authorField]),side=isOut(c,r)?'out':'in';
      var first=!prev||prev.author!==author||prev.side!==side||!t||!prev.t||t.min-prev.t.min>gap;
      var rid=String(blank(r[id])?'':r[id]);
      var li=h('li',{class:'cv-msg '+side+(first?' first':''),'data-row':rid,'data-side':side,'data-author':author});
      li.appendChild(h('span',{class:'cv-av','aria-hidden':'true',style:'--av:'+avColor(author)},[c.avatarField&&!blank(r[c.avatarField])?String(r[c.avatarField]).slice(0,3):initials(author)]));
      var b=h('div',{class:'cv-b'});
      if(first)b.appendChild(h('div',{class:'cv-who'},[author||el.missingText||'Unknown author']));
      var voice=c.voiceField&&!blank(r[c.voiceField])?Number(r[c.voiceField]):null;
      if(voice!==null)b.appendChild(voiceNode(voice));
      var text=c.textField&&!blank(r[c.textField])?String(r[c.textField]):'';
      if(text)b.appendChild(h('div',{class:'cv-text'},[text]));
      var att=c.attachments?(live[c.attachments.collection]||[]).filter(function(x){return String(x[c.attachments.matchField])===rid}):[];
      if(att.length){var g=h('div',{class:'cv-att'});att.forEach(function(x){g.appendChild(attNode(c.attachments,x))});b.appendChild(g)}
      if(!text&&voice===null&&!att.length)b.appendChild(h('div',{class:'miss'},[el.missingText||'Not provided']));
      b.appendChild(h('div',{class:'cv-foot'},[c.metaField&&!blank(r[c.metaField])?h('span',{class:'cv-tag'},[String(r[c.metaField])]):null,h('time',{datetime:blank(r[c.timeField])?null:String(r[c.timeField])},[t&&t.hm?t.hm:'\u2014'])]));
      li.appendChild(b);
      if(target&&target.param){
        li.setAttribute('tabindex','0');li.setAttribute('aria-current',String(openId===rid));li.setAttribute('data-fk','row:'+key+':'+rid);
        var open=function(){if(mode!=='preview')return;opener={fk:li.getAttribute('data-fk')};setParam(target.param,rid)};
        li.addEventListener('click',open);
        li.addEventListener('keydown',function(e){if(e.target===li&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open()}});
      }
      list.appendChild(li);prev={author:author,side:side,t:t};
    });
    feed.appendChild(list);
  }
  box.appendChild(feed);pendingScroll.push(feed);
  if(c.composer&&c.textField){
    var cp=c.composer,inp=h('input',{type:'text',placeholder:cp.placeholder||'Write a message','aria-label':cp.placeholder||'New message','data-fk':'compose:'+key});
    if(drafts[key])inp.value=drafts[key];
    inp.addEventListener('input',function(){drafts[key]=inp.value});
    var send=h('button',{type:'button',class:'btn','data-fk':'send:'+key},[cp.sendLabel||'Send']);
    var doSend=function(){if(mode!=='preview')return;var text=inp.value.trim();if(!text)return;
      var row={};Object.keys(cp.values||{}).forEach(function(k){row[k]=cp.values[k]});
      // the values of the active filters go into the new message, so it stays in the feed the person is looking at
      (el.filters||[]).forEach(function(f){var v=pv(f.param);if(v!==''&&!ignored(f,el.collection,v))row[f.field]=v});
      if(blank(row[c.authorField]))row[c.authorField]=(c.outgoingValues||[])[0];
      var of=c.outgoingField||c.authorField;if(blank(row[of])&&(c.outgoingValues||[]).length)row[of]=c.outgoingValues[0];
      row[c.timeField]=nowStamp();row[c.textField]=text;if(blank(row[id]))row[id]='NEW-'+(++newSeq);
      (live[el.collection]=live[el.collection]||[]).push(row);drafts[key]='';want='compose:'+key;render()};
    send.addEventListener('click',function(e){e.stopPropagation();doSend()});
    inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();doSend()}});
    box.appendChild(h('div',{class:'cv-compose'},[inp,send]));
  }
  return h('div',{},[box,h('div',{class:'count','data-count':String(rows.length)},['Showing '+rows.length+' of '+total])])
}
function flushScroll(){pendingScroll.forEach(function(f){f.scrollTop=f.scrollHeight});pendingScroll=[]}
// ---- custom: a sandboxed frame. It gets data by postMessage; the page never reads from it beyond a declared part id.
function frameData(f){var el=f.el,rows={};if(el.collection)rows[el.collection]=clone(rowsFor(el));((el.custom&&el.custom.collections)||[]).forEach(function(id){if(!(id in rows))rows[id]=clone(live[id]||[])});var query=clone(defaults(f.scr));Object.keys(q).forEach(function(k){query[k]=q[k]});return {screen:f.scr.id,query:query,role:role,dataset:dsId,rows:rows}}
function partOf(key){var i=String(sel||'').indexOf('@');return i>=0&&sel.slice(0,i)===key?sel.slice(i+1):''}
function postFrame(f,type){try{f.frame.contentWindow.postMessage(type==='praxis:mode'?{type:type,mode:mode,selected:partOf(f.key)}:{type:'praxis:data',mode:mode,selected:partOf(f.key),data:frameData(f)},'*')}catch(e){}}
function renderCustom(scr,el){
  var key=scr.id+'#'+el.id,doc=FRAMES[key];
  if(!el.custom||typeof doc!=='string')return emptyMsg('This custom part could not be loaded.');
  var fr=h('iframe',{class:'pv-custom',sandbox:'allow-scripts',referrerpolicy:'no-referrer',title:(el.label||'Custom part')+' (sandboxed)','data-frame':key,style:'height:'+Math.max(80,Math.min(2000,Number(el.custom.height)||480))+'px'});
  // drawn by the page, outside the frame: whatever the part draws inside its box (a button that looks like Accept), it is not this page's
  var cap=h('div',{class:'pv-custom-cap','data-custom-cap':key},[h('strong',{},['Custom part, sandboxed.']),T(' Controls inside this box only simulate the interface: they cannot save, comment or accept. Use this page\'s own controls.')]);
  var f={key:key,el:el,scr:scr,frame:fr,cap:cap,tokens:4,at:0};liveFrames[key]=f;
  fr.addEventListener('load',function(){postFrame(f,'praxis:data')});
  fr.setAttribute('srcdoc',doc);
  return h('div',{},[cap,fr])
}
// A frame can take the keyboard focus by itself. While the person is typing in this page, or with no user activation at all (a script
// cannot make one; a click in the frame gives one to this page too), the page takes the focus back, so a part cannot catch what the
// person types in a comment, and says so above the part. A frame that takes the focus when the person is not typing keeps it until
// they click elsewhere; it has nowhere to send what it receives.
var lastFocus=null,lastTab=0,lastType=0;
function activated(){var ua=navigator.userActivation;return !ua||ua.isActive}
document.addEventListener('focusin',function(e){if(e.target&&e.target.tagName!=='IFRAME')lastFocus=e.target});
document.addEventListener('keydown',function(e){if(e.key==='Tab')lastTab=Date.now();else lastType=Date.now()},true);
// text can arrive without key events (an input method, dictation, a phone keyboard): input in this page counts as typing too
document.addEventListener('input',function(){lastType=Date.now()},true);
window.addEventListener('blur',function(){setTimeout(function(){
  var a=document.activeElement,f=null,now=Date.now();Object.keys(liveFrames).forEach(function(k){if(liveFrames[k].frame===a)f=liveFrames[k]});
  if(!f||now-lastTab<1000||(activated()&&now-lastType>1500))return;
  try{if(lastFocus&&lastFocus.isConnected)lastFocus.focus();else a.blur()}catch(e){}
  if(!f.cap.querySelector('.stolen'))f.cap.appendChild(h('span',{class:'stolen',role:'status'},['This part tried to take the keyboard focus; the page took it back.']))},0)});
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
  else if(k==='conversation')node=renderConversation(scr,el);
  else if(k==='custom')node=renderCustom(scr,el);
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
  var tag=(el.requirementIds||[]).concat(el.acIds||[]).join(' ')||el.id;
  var wrap=h('div',{class:'el'+(k==='filter'||k==='field'?' row-el':''),'data-el':scr.id+'#'+el.id,'data-kind':k,'data-tag':k==='custom'?'custom (sandboxed) · '+tag:tag},[node]);
  if(sel===scr.id+'#'+el.id||String(sel||'').indexOf(scr.id+'#'+el.id+'@')===0)wrap.classList.add('sel');
  var cb=h('button',{type:'button',class:'pv-cbtn','aria-label':'Comment on '+el.id},['comment']);cb.addEventListener('click',function(e){e.stopPropagation();commentFor(scr.id+'#'+el.id)});wrap.appendChild(cb);
  return wrap
}
// a search box only narrows the tables: the box itself is never rebuilt, so focus and caret stay where they are
function refreshTables(){var scr=screenById(cur);if(!scr)return;$$('.el[data-kind=table],.el[data-kind=list],.el[data-kind=conversation]',host).forEach(function(w){var p=w.getAttribute('data-el').split('#');var el=scr.elements.filter(function(e){return e.id===p[1]})[0];if(el)w.replaceChild(el.kind==='conversation'?renderConversation(scr,el):renderTable(scr,el),w.firstChild)});flushScroll();Object.keys(liveFrames).forEach(function(k){postFrame(liveFrames[k],'praxis:data')})}
// ---- main render
var want=null;
function render(){
  var a=document.activeElement,fk=a&&a.getAttribute&&a.getAttribute('data-fk'),selStart=null;
  if(fk&&a.setSelectionRange&&a.type==='text'){try{selStart=[a.selectionStart,a.selectionEnd]}catch(e){}}
  host.textContent='';liveFrames={};pendingScroll=[];
  var scr=screenById(cur);
  $$('#proto-nav button').forEach(function(b){var on=b.getAttribute('data-screen')===cur;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on))});
  var sw=$('#proto-state');
  if(!scr){sw.textContent='';sw.disabled=true;host.appendChild(h('h2',{},['Page not found']));host.appendChild(emptyMsg('There is no screen "'+cur+'" in this prototype.'));if(document.activeElement!==urlIn)urlIn.value=buildUrl(cur,q);inspectorShow();return}
  sw.disabled=false;sw.textContent='';var states=scr.states&&scr.states.length?scr.states:['default'];states.forEach(function(s){var o=h('option',{value:s},[s]);if(s===stateName)o.selected=true;sw.appendChild(o)});
  if(states.indexOf(stateName)<0)stateName='default';
  host.appendChild(h('h2',{},[scr.title]));if(scr.description)host.appendChild(h('p',{class:'lead'},[scr.description]));
  var overlays=[];
  if(stateName==='default')normalize(scr);
  if(stateName==='empty'){
    // an empty screen still has its controls (filter, tabs, search); only the data areas say there is nothing
    scr.elements.forEach(function(el){
      if(!shown(el,scr)||el.kind==='modal'||el.kind==='drawer')return;
      if(el.kind==='table'||el.kind==='list'||el.kind==='conversation'){host.appendChild(h('div',{class:'state-msg empty','data-state':'empty'},[stateText(scr,'empty')]));return}
      var w=renderEl(scr,el);if(w)host.appendChild(w)});
  }
  else if(stateName!=='default'){host.appendChild(h('div',{class:'state-msg '+stateName,'data-state':stateName},[stateText(scr,stateName)]))}
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
  // the address shows what the page really has AFTER normalization (a dropped order must not linger in it)
  if(document.activeElement!==urlIn)urlIn.value=buildUrl(cur,q);
  flushScroll();
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
function setMode(m){mode=m;frame.setAttribute('data-mode',m);$$('#pv-mode button').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===m))});if(m==='inspect')showSide('inspect');if(m==='review')showSide('review');Object.keys(liveFrames).forEach(function(k){postFrame(liveFrames[k],'praxis:mode')})}
$$('#pv-mode button').forEach(function(b){b.addEventListener('click',function(){setMode(b.getAttribute('data-mode'))})});
function showSide(name){$$('[data-side]').forEach(function(b){b.setAttribute('aria-selected',String(b.getAttribute('data-side')===name))});$$('[data-sidepanel]').forEach(function(p){p.hidden=p.getAttribute('data-sidepanel')!==name})}
$$('[data-side]').forEach(function(b){b.addEventListener('click',function(){showSide(b.getAttribute('data-side'))})});
// A custom frame may only say which declared part was clicked: only in Inspect or Review, only while it has the focus and the page has
// a user activation (the person clicked into it; where the browser does not expose it, the focus alone), at most four a second. Anything else it sends is ignored; what the page then shows
// comes from the prototype data, never from the message.
window.addEventListener('message',function(e){
  var f=null;Object.keys(liveFrames).forEach(function(k){if(liveFrames[k].frame.contentWindow===e.source)f=liveFrames[k]});
  if(!f)return;var m=e.data;if(!m||typeof m!=='object'||typeof m.type!=='string')return;
  if(m.type==='praxis:ready'){postFrame(f,'praxis:data');return}
  if(m.type!=='praxis:pick'||mode==='preview'||document.activeElement!==f.frame||!activated())return;
  // a bucket of four picks that refills four a second: clicking is never dropped, a loop of messages is capped
  var now=Date.now();f.tokens=Math.min(4,f.tokens+(now-f.at)/250);f.at=now;if(f.tokens<1)return;f.tokens-=1;
  var part=typeof m.part==='string'&&m.part.length<=80?m.part:'';
  if(!((f.el.custom&&f.el.custom.parts)||[]).some(function(p){return p.id===part}))part='';
  var key=f.key+(part?'@'+part:'');if(key===sel&&mode==='inspect')return;select(key);if(mode==='review')commentFor(key)});
host.addEventListener('click',function(e){if(mode==='preview')return;var w=e.target.closest&&e.target.closest('[data-el]');if(!w||(e.target.closest&&e.target.closest('.pv-cbtn')))return;e.preventDefault();e.stopPropagation();select(w.getAttribute('data-el'));if(mode==='review')commentFor(w.getAttribute('data-el'))},true);
function select(key){sel=key;$$('[data-el]',host).forEach(function(n){var k=n.getAttribute('data-el');n.classList.toggle('sel',k===key||String(key||'').indexOf(k+'@')===0)});Object.keys(liveFrames).forEach(function(k){postFrame(liveFrames[k],'praxis:mode')});inspectorShow()}
// a key is "screen#element", or "screen#element@part" for a declared part of a custom element
function elOf(key){var p=String(key||'').split('#');var s=screenById(p[0]);if(!s)return null;var ep=String(p[1]||'').split('@');var el=s.elements.filter(function(e){return e.id===ep[0]})[0];var part=el&&ep[1]&&el.custom?(el.custom.parts||[]).filter(function(x){return x.id===ep[1]})[0]:null;return {scr:s,el:el,part:part||null}}
function label(key){var o=elOf(key);return o&&o.el?(o.scr.title+' > '+(o.el.label||o.el.text||o.el.kind)+(o.part?' > '+o.part.label:'')):key}
function behaviour(el){var out=[];
  if(el.kind==='conversation'&&el.conversation){var c=el.conversation;out.push('One message per row of "'+el.collection+'", in time order ("'+c.timeField+'"), a separator for each day');out.push((c.outgoingValues||[]).length?'Outgoing (right) when "'+(c.outgoingField||c.authorField)+'" is '+c.outgoingValues.join(' or ')+'; the others are incoming (left)':'Every message is incoming (left): no outgoing values');out.push('Messages by the same author within '+(c.groupMinutes===undefined?5:c.groupMinutes)+' min are grouped');if(c.voiceField)out.push('Voice messages ("'+c.voiceField+'" seconds): a mock player, no audio');if(c.attachments)out.push('Attachments from "'+c.attachments.collection+'"');if(c.composer)out.push('The box at the bottom adds a message to this page only; nothing is saved')}
  if(el.kind==='custom'&&el.custom){out.push('Custom part: HTML, CSS and script written for this prototype, run in a sandboxed frame (no network, no access to this page; nothing it does is saved or counts as a decision)');out.push('Why no structured element: '+el.custom.reason);out.push('Praxis does not check its behaviour or look; the scenarios cannot see inside it')}if(el.param&&(el.kind==='filter'||el.kind==='tabs'||el.kind==='drawer'||el.kind==='modal'))out.push('Reads and writes the URL parameter "'+el.param+'"');(el.filters||[]).forEach(function(f){out.push('Rows are narrowed by "'+f.param+'" on field "'+f.field+'"')});if(el.rowOpens)out.push('A click on a row opens '+el.rowOpens);if(el.showWhen)out.push('Shown only while '+el.showWhen.param+(el.showWhen.equals!==undefined?' = '+el.showWhen.equals:el.showWhen.notEquals!==undefined?' is not '+el.showWhen.notEquals:el.showWhen.present?' is set':' is not set'));if(el.allowedRoles&&el.allowedRoles.length)out.push('Roles: '+el.allowedRoles.join(', '));return out}
function inspectorShow(){
  var box=$('#pv-inspector');if(!box)return;box.textContent='';
  var o=elOf(sel);
  if(!o||!o.el){box.appendChild(h('p',{class:'muted'},['Switch to Inspect and click anything in the prototype to see which requirement and criteria it covers.']));return}
  var el=o.el,pt=o.part;
  if(pt){box.appendChild(h('h3',{},[pt.label]));box.appendChild(h('p',{class:'meta'},['part of the custom element "'+(el.label||el.id)+'" on "'+o.scr.title+'" - '+o.scr.id+'#'+el.id+'@'+pt.id]))}
  else{box.appendChild(h('h3',{},[el.label||el.text||el.kind]));box.appendChild(h('p',{class:'meta'},[el.kind+' on "'+o.scr.title+'"'+(el.intent?' - '+el.intent:'')+' - '+o.scr.id+'#'+el.id]))}
  var reqs=pt?pt.requirementIds||[]:el.requirementIds||[],acs=pt?pt.acIds||[]:el.acIds||[];
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
var rs=$('#proto-reset');if(rs)rs.addEventListener('click',function(){loadData();search={};form={};formErr={};drafts={};render()});
$$('#pv-vp button').forEach(function(b){b.addEventListener('click',function(){var m=b.getAttribute('data-vp')==='mobile';device.classList.toggle('mobile',m);$$('#pv-vp button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))})})});
$('#proto-addr').addEventListener('submit',function(e){e.preventDefault();var u=parseUrl(urlIn.value);stateName='default';cur=u.screen||startId;q=u.query;pushUrl(false);render()});
function syncFromHash(){var u=parseUrl(location.hash);cur=u.screen||startId;q=u.query;stateName='default';render()}
window.addEventListener('popstate',syncFromHash);window.addEventListener('hashchange',syncFromHash);
// ---- scenarios
function applyScenario(sc){
  dsId=sc.dataset||'';if(dsSel)dsSel.value=dsId;role=sc.role||role0;if(rl)rl.value=role;stateName='default';search={};form={};formErr={};loadData();cur=sc.screen||startId;q=clone(sc.query||{});curScenario=sc.id;pushUrl(false);render()}
function checkScenario(sc){
  var fails=[],ex=sc.expect;if(!ex)return null;
  (ex.rows||[]).forEach(function(r){var w=by('data-el',cur+'#'+r.element,host);var n=w?$$('[data-row]',w).length:0;if(n!==r.count)fails.push(r.element+': '+n+' row(s), expected '+r.count)});
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
$$('[data-goto]').forEach(function(b){b.addEventListener('click',function(){var key=b.getAttribute('data-goto');var parts=key.split('#');stateName='default';setMode('inspect');go(parts[0],{});select(key);var w=by('data-el',key.split('@')[0],host);if(w&&w.scrollIntoView)w.scrollIntoView({block:'center'})})});
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
  const elementLine = (screen: PrototypeScreen, e: PrototypeElement) => `<li><button type="button" class="gt" data-goto="${esc(screen.id)}#${esc(e.id)}">${esc(screen.title)} &rsaquo; ${esc(e.label || e.text || e.kind)}</button> <span class="meta">${esc(e.kind === "custom" ? "custom (sandboxed)" : e.kind)}${e.acIds.length ? ` · ${esc(e.acIds.join(", "))}` : ""}</span></li>`;
  const partLine = (screen: PrototypeScreen, e: PrototypeElement, part: { id: string; label: string; acIds: string[] }) =>
    `<li><button type="button" class="gt" data-goto="${esc(screen.id)}#${esc(e.id)}@${esc(part.id)}">${esc(screen.title)} &rsaquo; ${esc(e.label || e.kind)} &rsaquo; ${esc(part.label)}</button> <span class="meta">custom part${part.acIds.length ? ` · ${esc(part.acIds.join(", "))}` : ""}</span></li>`;
  const owners = (requirementIds: string[], acIds: string[]) => {
    const ids = new Set(requirementIds);
    for (const ac of acIds) for (const r of reqs) if (r.acceptanceCriteria.some((c) => c.id === ac)) ids.add(r.id);
    return ids;
  };
  for (const screen of proto.screens)
    for (const e of screen.elements) {
      const parts = e.custom?.parts ?? [];
      for (const part of parts) for (const id of owners(part.requirementIds, part.acIds)) groups.get(id)?.items.push(partLine(screen, e, part));
      if (!e.requirementIds.length && !e.acIds.length) {
        if (e.kind !== "heading" && e.kind !== "text" && !parts.some((p) => p.requirementIds.length || p.acIds.length)) unlinked.push(elementLine(screen, e));
        continue;
      }
      for (const id of owners(e.requirementIds, e.acIds)) groups.get(id)?.items.push(elementLine(screen, e));
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
    ...proto.screens.flatMap((s) =>
      s.elements
        .filter((e) => e.kind === "custom" && e.custom)
        .map((e) => `Custom part «${esc(e.label || e.id)}» on ${esc(s.title)}: HTML, CSS and script written for this prototype, run in a sandboxed frame with no network and no access to this page. Why: ${esc(e.custom!.reason)}. Praxis checks neither its behaviour nor its look, and the scenarios cannot see inside it.`),
    ),
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
<div class="pv-device" id="pv-device"><form class="pv-addr" id="proto-addr" autocomplete="off"><span title="A simulated address: the prototype keeps its screen and query parameters in this page's #hash. It is not a real URL of the application.">prototype:// <em>(simulated)</em></span><input id="proto-url" type="text" aria-label="Prototype address (screen and query parameters)" spellcheck="false"></form>
<div class="proto" id="proto-frame" data-mode="preview" style="${esc(vars)}"><div class="nav" id="proto-nav" role="tablist" aria-label="Screens">${proto.screens.map((s) => `<button type="button" role="tab" data-screen="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>
<div class="screen" id="proto-screen" tabindex="-1"></div></div></div>
${fidelity(proto)}</section>
<aside class="pv-side" aria-label="Review panel"><div class="pv-tabs" role="tablist"><button type="button" role="tab" data-side="review" aria-selected="true">Review</button><button type="button" role="tab" data-side="inspect" aria-selected="false">Inspector</button><button type="button" role="tab" data-side="scenarios" aria-selected="false">Scenarios${scenarios ? ` (${scenarios})` : ""}</button></div>
<div class="pv-panel" data-sidepanel="review"><p class="meta">Use the prototype in Preview. Switch to Review and click anything to leave a comment on it.</p><div id="fb-list"></div><button id="fb-add" type="button">Comment on the prototype as a whole</button>${feedback ? `<h3>Earlier comments</h3>${feedback}` : ""}</div>
<div class="pv-panel" data-sidepanel="inspect" hidden><div id="pv-inspector"></div></div>
<div class="pv-panel" data-sidepanel="scenarios" hidden><p class="meta">Self-check: these checks were written together with the prototype and run in this page. They show the prototype does what its author says; they are not an independent test of the application (Quality verifies that against the real code).</p><div class="row" style="justify-content:space-between;align-items:center"><span class="meta" id="sc-summary" role="status"></span>${scenarios ? `<button type="button" id="sc-run-all">Run all checks</button>` : ""}</div><div id="pv-scenarios"></div></div></aside></div>
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
  // the documents of the custom frames: data for the page's script, which puts them in sandboxed frames and nowhere else
  const frames: Record<string, string> = {};
  for (const s of proto.screens) for (const e of s.elements) if (e.kind === "custom" && e.custom) frames[`${s.id}#${e.id}`] = customFrameDocument(e.custom, vars);
  const screens = proto.screens.map((s) => ({ ...s, elements: s.elements.map((e) => (e.custom ? { ...e, custom: { ...e.custom, html: "", css: "", script: "" } } : e)) }));
  return {
    body,
    clientData: { proto: { kind: proto.kind, startScreen: proto.startScreen, roles: proto.roles, screens, mock: proto.mock, datasets: proto.datasets, scenarios: proto.scenarios }, trace, acText, ...(Object.keys(frames).length ? { frames } : {}) },
  };
}
