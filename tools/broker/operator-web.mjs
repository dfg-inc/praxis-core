/**
 * Operator web channel for the approval broker. A person reviews the exact plan in a browser and approves or
 * rejects with a WebAuthn gesture (Touch ID, a security key). The broker verifies the signature itself and
 * only then signs the plan. An agent that can call every endpoint here still cannot approve, because
 * approving needs a signature from an enrolled authenticator it does not hold.
 *
 * Must run under the broker identity. Binds 127.0.0.1 only. The page is the human's view; the security
 * comes from the verified assertion over a challenge that hashes the exact decision.
 */
import { createServer } from "node:http";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { b64u, decisionChallenge, newNonce, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.mjs";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHALLENGE_TTL_MS = 120_000;
const MAX_CHALLENGES = 32;
const MAX_BODY = 65_536;

const KIND_LABEL = {
  requirement_acceptance: "Requirement confirmation",
  architecture_decision: "Architecture decision",
  story_behavior: "Story behavior confirmation",
  development_action: "Implementation authorization",
  quality_verdict: "Quality verdict",
  issue_tracker_mutation: "Issue tracker change",
};
const OPERATION_LABEL = {
  git_commit: "Git commit",
  git_push: "Git push",
  merge_request: "Merge request",
  merge: "Merge",
  deploy: "Deploy",
  release: "Release",
};

export function authorityLabel(plan) {
  if (plan.decisionKind === "git_operation") return OPERATION_LABEL[plan.operations[0]] ?? "Git operation";
  return KIND_LABEL[plan.decisionKind] ?? plan.decisionKind;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function equalSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

function writeJsonAtomic(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, path);
  chmodSync(path, mode);
}

export function createOperatorWeb({ origin, trustedDir, sharedDir, contracts, signApproved, rejectPlan, enrollSecret, multiEnroll = false, now = () => Date.now() }) {
  const base = new URL(origin);
  const rpId = base.hostname;
  const operatorsPath = join(resolve(trustedDir), "operators.json");
  const pendingDir = join(resolve(sharedDir), "pending");
  const challenges = new Map();
  let secret = enrollSecret;

  const readOperators = () =>
    existsSync(operatorsPath) ? JSON.parse(readFileSync(operatorsPath, "utf8")) : { version: 1, rpId, origin, credentials: [] };
  const writeOperators = (doc) => writeJsonAtomic(operatorsPath, doc);

  function loadPlan(planId) {
    if (!PLAN_ID.test(planId ?? "")) throw httpError(400, "BAD_PLAN_ID", "plan id is not valid");
    const path = join(pendingDir, `${planId}.json`);
    if (!existsSync(path)) throw httpError(404, "PLAN_NOT_PENDING", "no pending plan with that id (it may have been decided already)");
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw httpError(422, "PLAN_UNREADABLE", "the pending plan is not valid JSON");
    }
    const parsed = contracts.ActionPlanSchema.safeParse(raw);
    if (!parsed.success) {
      throw httpError(422, "PLAN_INVALID", `the plan is not valid and cannot be approved: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    if (Date.parse(parsed.data.expiresAt) <= now()) throw httpError(410, "PLAN_EXPIRED", "the plan has expired");
    return parsed.data;
  }

  const transactionOf = (plan, decision, nonce) => ({
    kind: "praxis-approval",
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    decisionKind: plan.decisionKind,
    operations: plan.operations,
    provider: plan.provider,
    instanceId: plan.instanceId,
    decision,
    nonce,
  });

  function sweep() {
    for (const [id, record] of challenges) if (record.expires <= now()) challenges.delete(id);
  }

  function issue(record) {
    sweep();
    if (challenges.size >= MAX_CHALLENGES) throw httpError(429, "TOO_MANY_CHALLENGES", "too many open decisions; try again shortly");
    const id = newNonce();
    challenges.set(id, { ...record, expires: now() + CHALLENGE_TTL_MS });
    return id;
  }

  // The challenge is single use: it is removed the moment a decision is attempted, successful or not.
  function consume(id) {
    const record = challenges.get(id);
    challenges.delete(id);
    if (!record) throw httpError(409, "CHALLENGE_UNKNOWN", "this decision was already used, expired, or never issued");
    if (record.expires <= now()) throw httpError(410, "CHALLENGE_EXPIRED", "the decision expired; start again");
    return record;
  }

  function httpError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  // --- API ------------------------------------------------------------------------------------------------

  const api = {
    "POST /api/challenge": (body) => {
      const decision = body.decision === "reject" ? "reject" : body.decision === "approve" ? "approve" : null;
      if (!decision) throw httpError(400, "BAD_DECISION", "decision must be approve or reject");
      const operators = readOperators();
      if (operators.credentials.length === 0) throw httpError(409, "NO_OPERATOR", "no operator authenticator is enrolled; enroll one first");
      const plan = loadPlan(body.planId);
      const nonce = newNonce();
      const challengeId = issue({ type: "decision", planId: plan.planId, fingerprint: plan.fingerprint, decision, nonce });
      return {
        challengeId,
        publicKey: {
          challenge: decisionChallenge(transactionOf(plan, decision, nonce)),
          rpId,
          timeout: CHALLENGE_TTL_MS,
          userVerification: "required",
          allowCredentials: operators.credentials.map((credential) => ({ type: "public-key", id: credential.id })),
        },
      };
    },

    "POST /api/decide": (body) => {
      const record = consume(body.challengeId);
      if (record.type !== "decision") throw httpError(409, "WRONG_CEREMONY", "that challenge was not issued for a decision");
      // Re-read the plan now: if it changed after the human was shown it, the fingerprint no longer matches.
      const plan = loadPlan(record.planId);
      if (plan.fingerprint !== record.fingerprint) {
        throw httpError(409, "PLAN_CHANGED", "the plan changed after it was shown; nothing was approved. Review the new plan.");
      }
      const operators = readOperators();
      const credential = operators.credentials.find((item) => item.id === body.credential?.id);
      if (!credential) throw httpError(403, "UNKNOWN_CREDENTIAL", "that authenticator is not enrolled with this broker");
      let assertion;
      try {
        assertion = verifyAssertion({
          clientDataJSON: b64u.decode(body.credential.response.clientDataJSON),
          authenticatorData: b64u.decode(body.credential.response.authenticatorData),
          signature: b64u.decode(body.credential.response.signature),
          expectedChallenge: decisionChallenge(transactionOf(plan, record.decision, record.nonce)),
          origin,
          rpId,
          publicKeyJwk: credential.publicKeyJwk,
          storedSignCount: credential.signCount ?? 0,
        });
      } catch (error) {
        if (error instanceof WebAuthnError) throw httpError(403, error.code, error.message);
        throw httpError(400, "WEBAUTHN_MALFORMED", "the assertion could not be read");
      }
      credential.signCount = assertion.signCount;
      credential.lastUsedAt = new Date(now()).toISOString();
      writeOperators(operators);
      const approver = `operator:${credential.label}`;
      const channel = `webauthn:${credential.id.slice(0, 12)}`;
      if (record.decision === "reject") {
        rejectPlan(plan, approver, channel);
        return { ok: true, planId: plan.planId, state: "rejected", channel };
      }
      const signed = signApproved(plan, approver, channel);
      return { ok: true, planId: plan.planId, state: "approved", channel, consumptionId: signed.consumptionId };
    },

    "POST /api/enroll/challenge": (body) => {
      if (!secret) throw httpError(403, "ENROLLMENT_CLOSED", "enrollment is not open on this broker");
      if (!equalSecret(body.secret, secret)) throw httpError(403, "ENROLLMENT_SECRET", "wrong enrollment secret");
      const label = String(body.label ?? "operator").slice(0, 40).replace(/[^\w .@-]/g, "") || "operator";
      const challenge = newNonce();
      const challengeId = issue({ type: "enroll", challenge, label });
      const operators = readOperators();
      return {
        challengeId,
        publicKey: {
          challenge,
          rp: { id: rpId, name: "Praxis approval broker" },
          user: { id: newNonce().slice(0, 22), name: label, displayName: label },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
          attestation: "none",
          timeout: CHALLENGE_TTL_MS,
          excludeCredentials: operators.credentials.map((credential) => ({ type: "public-key", id: credential.id })),
        },
      };
    },

    "POST /api/enroll/finish": (body) => {
      if (!secret) throw httpError(403, "ENROLLMENT_CLOSED", "enrollment is not open on this broker");
      if (!equalSecret(body.secret, secret)) throw httpError(403, "ENROLLMENT_SECRET", "wrong enrollment secret");
      const record = consume(body.challengeId);
      if (record.type !== "enroll") throw httpError(409, "WRONG_CEREMONY", "that challenge was not issued for enrollment");
      let registered;
      try {
        registered = verifyRegistration({
          clientDataJSON: b64u.decode(body.credential.response.clientDataJSON),
          attestationObject: b64u.decode(body.credential.response.attestationObject),
          expectedChallenge: record.challenge,
          origin,
          rpId,
        });
      } catch (error) {
        if (error instanceof WebAuthnError) throw httpError(403, error.code, error.message);
        throw httpError(400, "WEBAUTHN_MALFORMED", "the registration could not be read");
      }
      const operators = readOperators();
      if (operators.credentials.some((item) => item.id === registered.credentialId)) {
        throw httpError(409, "ALREADY_ENROLLED", "that authenticator is already enrolled");
      }
      operators.rpId = rpId;
      operators.origin = origin;
      operators.credentials.push({
        id: registered.credentialId,
        label: record.label,
        publicKeyJwk: registered.publicKeyJwk,
        signCount: registered.signCount,
        attestationFormat: registered.attestationFormat,
        aaguid: registered.aaguid,
        enrolledAt: new Date(now()).toISOString(),
      });
      writeOperators(operators);
      if (!multiEnroll) secret = undefined; // one authenticator per enrollment ceremony
      return { ok: true, credentialId: registered.credentialId, label: record.label, enrollmentClosed: !secret };
    },
  };

  // --- pages ------------------------------------------------------------------------------------------------

  const page = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f}pre{background:#f3f3f6;padding:1rem;border-radius:8px;white-space:pre-wrap;word-break:break-word}` +
    `.kind{display:inline-block;background:#1b1b1f;color:#fff;padding:.2rem .6rem;border-radius:6px;font-weight:600}.warn{border-left:4px solid #b45309;padding:.4rem .8rem;background:#fffbeb}` +
    `button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;cursor:pointer;margin-right:.6rem}button.go{background:#166534;color:#fff;border-color:#166534}button.no{background:#fff}#out{margin-top:1rem;font-weight:600}@media(prefers-color-scheme:dark){body{background:#17171a;color:#eee}pre{background:#24242a}.warn{background:#2a2110}}</style></head><body>${body}<script src="/app.js"></script></body></html>`;

  function indexPage() {
    const operators = readOperators();
    let rows = "";
    if (existsSync(pendingDir)) {
      for (const name of readdirSync(pendingDir).filter((file) => file.endsWith(".json")).sort()) {
        try {
          const plan = loadPlan(name.slice(0, -5));
          rows += `<li><a href="/plan/${encodeURIComponent(plan.planId)}"><strong>${escapeHtml(authorityLabel(plan))}</strong></a> — ${escapeHtml(plan.summary)} <small>(${escapeHtml(plan.planId)})</small></li>`;
        } catch (error) {
          rows += `<li>${escapeHtml(name)}: <em>cannot be approved (${escapeHtml(error.message)})</em></li>`;
        }
      }
    }
    return page(
      "Praxis approvals",
      `<h1>Praxis approvals</h1><p>${operators.credentials.length} enrolled authenticator(s).${secret ? ' <a href="/enroll">Enroll one</a>.' : ""}</p>` +
        `<h2>Waiting for a decision</h2><ul>${rows || "<li>Nothing is waiting.</li>"}</ul>`,
    );
  }

  function planPage(plan) {
    const label = authorityLabel(plan);
    const first = plan.actions[0];
    const targets = plan.actions.flatMap((action) => action.targets);
    return page(
      `${label} — ${plan.planId}`,
      `<p><span class="kind">${escapeHtml(label)}</span></p><h1>${escapeHtml(plan.summary)}</h1>` +
        `<p class="warn"><strong>This approves only: ${escapeHtml(label)}.</strong> It does not confirm requirements or stories, accept architecture decisions, authorize implementation, record a quality verdict, commit, push, merge or release anything else. Each of those needs its own approval.</p>` +
        `<p>Proposed by role <strong>${escapeHtml(plan.role)}</strong> against <strong>${escapeHtml(plan.provider)} / ${escapeHtml(plan.instanceId)}</strong>. Operations: <strong>${escapeHtml(plan.operations.join(", "))}</strong>. Targets: ${escapeHtml(targets.join(", ") || "none")}. Expires ${escapeHtml(plan.expiresAt)}.</p>` +
        `<p>Exactly what will be approved (fingerprint <code>${escapeHtml(plan.fingerprint)}</code>):</p><pre>${escapeHtml(contracts.renderActionPlanForHuman(plan))}</pre>` +
        (first && first.content !== undefined ? `<p>Exact content to be written:</p><pre>${escapeHtml(first.content)}</pre>` : "") +
        `<p><button class="go" data-decide="approve" data-plan="${escapeHtml(plan.planId)}">Approve with authenticator</button><button class="no" data-decide="reject" data-plan="${escapeHtml(plan.planId)}">Reject</button></p><div id="out" role="status"></div>`,
    );
  }

  const enrollPage = () =>
    page(
      "Enroll an authenticator",
      `<h1>Enroll an authenticator</h1><p class="warn">Enroll only a device you physically hold and control. Anything enrolled here can approve plans. The enrollment secret is shown on the broker's terminal, not here.</p>` +
        `<p><label>Enrollment secret <input id="secret" type="password" autocomplete="off"></label></p><p><label>Name <input id="label" value="operator"></label></p>` +
        `<p><button class="go" id="enroll">Enroll this device</button></p><div id="out" role="status"></div>`,
    );

  const appJs = `
const b64u=(buf)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64u=(s)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
const out=(t,ok)=>{const o=document.getElementById('out');if(o){o.textContent=t;o.style.color=ok?'#166534':'#b91c1c'}};
const post=async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error((j.code?j.code+': ':'')+(j.error||r.status));return j};
document.querySelectorAll('[data-decide]').forEach(btn=>btn.addEventListener('click',async()=>{
  try{
    out('Waiting for your authenticator…',true);
    const c=await post('/api/challenge',{planId:btn.dataset.plan,decision:btn.dataset.decide});
    const pk=c.publicKey;
    const cred=await navigator.credentials.get({publicKey:{challenge:unb64u(pk.challenge),rpId:pk.rpId,timeout:pk.timeout,userVerification:'required',allowCredentials:pk.allowCredentials.map(a=>({type:a.type,id:unb64u(a.id)}))}});
    const r=cred.response;
    const d=await post('/api/decide',{challengeId:c.challengeId,credential:{id:b64u(cred.rawId),response:{clientDataJSON:b64u(r.clientDataJSON),authenticatorData:b64u(r.authenticatorData),signature:b64u(r.signature)}}});
    out(d.state==='approved'?'Approved. The agent can now use the signed approval for exactly this plan.':'Rejected. Nothing was approved.',true);
    document.querySelectorAll('button').forEach(b=>b.disabled=true);
  }catch(e){out('Not decided: '+e.message,false)}
}));
const enroll=document.getElementById('enroll');
if(enroll)enroll.addEventListener('click',async()=>{
  try{
    const secret=document.getElementById('secret').value,label=document.getElementById('label').value;
    const c=await post('/api/enroll/challenge',{secret,label});
    const pk=c.publicKey;
    const cred=await navigator.credentials.create({publicKey:{challenge:unb64u(pk.challenge),rp:pk.rp,user:{id:unb64u(pk.user.id),name:pk.user.name,displayName:pk.user.displayName},pubKeyCredParams:pk.pubKeyCredParams,authenticatorSelection:pk.authenticatorSelection,attestation:'none',timeout:pk.timeout,excludeCredentials:pk.excludeCredentials.map(a=>({type:a.type,id:unb64u(a.id)}))}});
    const r=cred.response;
    await post('/api/enroll/finish',{secret,challengeId:c.challengeId,credential:{id:b64u(cred.rawId),response:{clientDataJSON:b64u(r.clientDataJSON),attestationObject:b64u(r.attestationObject)}}});
    out('Enrolled. Enrollment is now closed.',true);
  }catch(e){out('Not enrolled: '+e.message,false)}
});
`;

  // --- http -------------------------------------------------------------------------------------------------

  const HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };

  const send = (res, status, body, type = "text/html; charset=utf-8") => {
    res.writeHead(status, { ...HEADERS, "content-type": type });
    res.end(body);
  };

  const server = createServer((req, res) => {
    const finish = (error) => {
      const status = error.status ?? 500;
      send(res, status, JSON.stringify({ ok: false, code: error.code ?? "ERROR", error: status === 500 ? "internal error" : error.message }), "application/json");
    };
    try {
      // DNS rebinding: only our own host name is served.
      if (req.headers.host !== base.host) return send(res, 403, "wrong host");
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET") {
        if (url.pathname === "/") return send(res, 200, indexPage());
        if (url.pathname === "/app.js") return send(res, 200, appJs, "text/javascript; charset=utf-8");
        if (url.pathname === "/enroll") return send(res, 200, enrollPage());
        const match = /^\/plan\/([^/]+)$/.exec(url.pathname);
        if (match) {
          try {
            return send(res, 200, planPage(loadPlan(decodeURIComponent(match[1]))));
          } catch (error) {
            return send(res, error.status ?? 500, page("Cannot show plan", `<h1>Cannot show this plan</h1><p>${escapeHtml(error.message)}</p><p><a href="/">Back</a></p>`));
          }
        }
        return send(res, 404, "not found");
      }
      if (req.method === "POST") {
        if (req.headers.origin !== origin) return send(res, 403, JSON.stringify({ ok: false, code: "ORIGIN", error: "wrong origin" }), "application/json");
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, JSON.stringify({ ok: false, code: "CONTENT_TYPE", error: "expected application/json" }), "application/json");
        }
        const handler = api[`POST ${url.pathname}`];
        if (!handler) return send(res, 404, JSON.stringify({ ok: false, code: "NOT_FOUND", error: "not found" }), "application/json");
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const result = handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            send(res, 200, JSON.stringify(result), "application/json");
          } catch (error) {
            finish(error instanceof SyntaxError ? Object.assign(error, { status: 400, code: "BAD_JSON" }) : error);
          }
        });
        return;
      }
      return send(res, 405, "method not allowed");
    } catch (error) {
      finish(error);
    }
  });

  return { server, rpId, operatorsPath, openChallenges: () => challenges.size, closeEnrollment: () => (secret = undefined) };
}

/** Approve at most once per plan, even under a race: the token file is created exclusively. */
export function writeTokenOnce(tokenPath, token) {
  mkdirSync(dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  try {
    linkSync(tmp, tokenPath); // fails with EEXIST if an approval already exists
  } catch (error) {
    if (error.code === "EEXIST") {
      const duplicate = new Error("this plan has already been approved; a second approval would create a second authorization");
      duplicate.status = 409;
      duplicate.code = "ALREADY_APPROVED";
      throw duplicate;
    }
    throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}
