#!/usr/bin/env node
import {
  loadApplicableSlice,
  loadFindingStore,
  prepareFindingProposal,
  rejectFindingProposal,
  acceptFindingProposal,
  saveFindingStore,
  parsePrecedent,
} from "../dist/index.js";

function usage() {
  console.error(`usage:
  praxis-knowledge slice --root <path> --role <role> --stage <stage> [--product <id>] [--service <id>]
  praxis-knowledge precedent --path <file.md>
  praxis-knowledge finding propose --store <path> --kind <kind> --id <ruleId> --title <t> --body <b> --ref <r> [--ref <r>...]
  praxis-knowledge finding reject --store <path> --id <ruleId> --reason <text>
  praxis-knowledge finding accept --store <path> --id <ruleId>
  praxis-knowledge finding list --store <path>`);
  process.exit(2);
}

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function flags(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

const cmd = args[0];
if (cmd === "precedent") {
  const path = flag("--path");
  if (!path) usage();
  const parsed = parsePrecedent(path);
  console.log(JSON.stringify(parsed, null, 2));
  process.exit("error" in parsed ? 1 : 0);
}
if (cmd === "slice") {
  const root = flag("--root");
  const role = flag("--role");
  const stage = flag("--stage");
  if (!root || !role || !stage) usage();
  const result = loadApplicableSlice({
    knowledgeRoot: root,
    role,
    stage,
    product: flag("--product"),
    service: flag("--service"),
  });
  for (const err of result.errors) console.error(`error: ${err}`);
  if (result.emptyMessage) {
    console.log(result.emptyMessage);
    process.exit(0);
  }
  console.log(`applicable rules: ${result.rules.length}`);
  for (const rule of result.rules) {
    const ov = rule.overriddenBy ? ` (overrides prior level)` : "";
    console.log(
      `- ${rule.frontmatter.id} [${rule.level}/${rule.frontmatter.severity}]${ov}`,
    );
  }
  process.exit(0);
}

if (cmd === "finding") {
  const sub = args[1];
  const storePath = flag("--store");
  if (!storePath) usage();
  const store = loadFindingStore(storePath);
  if (sub === "list") {
    console.log(JSON.stringify(store, null, 2));
    process.exit(0);
  }
  if (sub === "propose") {
    const kind = flag("--kind");
    const id = flag("--id");
    const title = flag("--title");
    const body = flag("--body");
    const refs = flags("--ref");
    if (!kind || !id || !title || !body || refs.length === 0) usage();
    const result = prepareFindingProposal(store, {
      kind,
      proposedRuleId: id,
      title,
      body,
      sourceRefs: refs,
    });
    saveFindingStore(storePath, store);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "proposed" ? 0 : 1);
  }
  if (sub === "reject") {
    const id = flag("--id");
    const reason = flag("--reason");
    if (!id || !reason) usage();
    const proposal = [...store.proposals].reverse().find((p) => p.proposedRuleId === id);
    if (!proposal) {
      console.error(`no proposal for ${id}`);
      process.exit(1);
    }
    rejectFindingProposal(store, proposal, reason);
    saveFindingStore(storePath, store);
    console.log(JSON.stringify({ ok: true, proposal }, null, 2));
    process.exit(0);
  }
  if (sub === "accept") {
    const id = flag("--id");
    if (!id) usage();
    const proposal = [...store.proposals].reverse().find((p) => p.proposedRuleId === id);
    if (!proposal) {
      console.error(`no proposal for ${id}`);
      process.exit(1);
    }
    acceptFindingProposal(store, proposal);
    saveFindingStore(storePath, store);
    console.log(JSON.stringify({ ok: true, proposal }, null, 2));
    process.exit(0);
  }
}

usage();
