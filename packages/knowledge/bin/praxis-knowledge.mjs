#!/usr/bin/env node
import {
  loadApplicableSlice,
  loadFindingStore,
  prepareFindingProposal,
  prepareSuccessfulOverrideFinding,
  rejectFindingProposal,
  acceptFindingProposal,
  saveFindingStore,
  parsePrecedent,
  ruleRequiresObsoleteToolReview,
} from "../dist/index.js";

function usage() {
  console.error(`usage:
  praxis-knowledge slice --root <path> --role <role> --stage <stage> [--product <id>] [--service <id>]
  praxis-knowledge precedent --path <file.md>
  praxis-knowledge finding propose --store <path> --kind <kind> --id <ruleId> --title <t> --body <b> --ref <r> [--ref <r>...]
  praxis-knowledge finding successful-override --store <path> --original-rule <id> --override-level <product|service> --override-source <id> [--ref <r>...]
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
  if (result.rules.length === 0) {
    console.log(result.emptyMessage ?? "applicable rules: none");
  } else {
    console.log(`applicable rules: ${result.rules.length}`);
    for (const rule of result.rules) {
      const ov = rule.overriddenBy ? ` (overrides prior level)` : "";
      const review = ruleRequiresObsoleteToolReview(rule)
        ? ` [obsolete-tool-review:${rule.frontmatter.obsoleteToolBinding.toolId}]`
        : "";
      console.log(
        `- ${rule.frontmatter.id} [${rule.level}/${rule.frontmatter.severity}]${ov}${review}`,
      );
      if (rule.frontmatter.sourceDoc) {
        console.log(
          `  source: ${rule.frontmatter.sourceDoc}@${rule.frontmatter.sourceVersion ?? "?"}`,
        );
      }
    }
  }
  if (result.precedents.length) {
    console.log(`applicable precedents: ${result.precedents.length}`);
    for (const p of result.precedents) {
      console.log(`- ${p.frontmatter.id} [${p.level}]`);
    }
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
  if (sub === "successful-override") {
    const originalRule = flag("--original-rule");
    const overrideLevel = flag("--override-level");
    const overrideSource = flag("--override-source");
    const refs = flags("--ref");
    if (
      !originalRule ||
      (overrideLevel !== "product" && overrideLevel !== "service") ||
      !overrideSource
    ) {
      usage();
    }
    const result = prepareSuccessfulOverrideFinding(store, {
      originalRuleId: originalRule,
      overrideLevel,
      overrideSource,
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
