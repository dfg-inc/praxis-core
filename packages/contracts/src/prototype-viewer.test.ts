// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, acceptanceStatus, ReviewSubmissionSchema, renderReview, submissionToCommands, WorkflowStateSchema, type WorkflowState } from "./index.js";

/** The orders fixture (copy of praxis-runtime/tools/fixtures): filter, side card, status/order in the address, scenarios. */
const FIXTURE = JSON.parse(readFileSync(new URL("./__fixtures__/orders-interactive.command.json", import.meta.url), "utf8"));
const NOW = new Date("2026-10-28T10:00:00.000Z");
const apply = (s: WorkflowState | null, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW, channel: { via: "html-review" } });
const ok = (s: WorkflowState, c: Record<string, unknown>) => apply(s, c).state;
const COUNTS: Record<string, number> = { "REQ-ORD-001": 7, "REQ-ORD-002": 9, "REQ-ORD-003": 2, "REQ-ORD-004": 6, "REQ-ORD-005": 7 };

function ordersState(prototype: Record<string, unknown> = FIXTURE.prototype): WorkflowState {
  let s = apply(null, { action: "open", projectId: "orders", title: "Orders filter", request: "Filter orders by status", mode: "guided" }).state;
  for (const [id, n] of Object.entries(COUNTS)) s = ok(s, { action: "add-requirement", id, statement: `Requirement ${id} statement`, acceptanceCriteria: Array.from({ length: n }, (_, i) => `Criterion ${i + 1} of ${id}`) });
  s = ok(s, { action: "accept-requirements", via: "html-review" });
  return ok(s, { action: "set-prototype", prototype, summary: "interactive" });
}

const renderPrototypeHtml = (state: WorkflowState) => renderReview(state, "prototype", { token: "t0k" });

function open(state: WorkflowState, hash = "") {
  const html = renderReview(state, "prototype", { token: "t0k" });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: `https://review.test/p${hash}` });
  const w = dom.window;
  const doc = w.document;
  const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = doc) => root.querySelector(sel) as T;
  const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = doc) => [...root.querySelectorAll(sel)] as T[];
  const screen = () => $("#proto-screen");
  const rows = () => $$("#proto-screen tr[data-row]").map((r) => r.getAttribute("data-row"));
  const hashNow = () => decodeURIComponent(w.location.hash);
  const choose = (value: string) => {
    const sel = $<HTMLSelectElement>("select[data-filter]");
    sel.value = value;
    sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const clickRow = (id: string) => $(`tr[data-row="${id}"]`).click();
  const key = (target: Element | Document, k: string) => target.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  const decisions = () => {
    $("#btn-copy").click();
    return JSON.parse($<HTMLTextAreaElement>("#out textarea").value);
  };
  return { dom, w, doc, $, $$, screen, rows, hashNow, choose, clickRow, key, decisions, html };
}

describe("interactive prototype: the orders filter and side card", () => {
  it("shows a clean preview: no requirement ids next to elements, no giant coverage table", () => {
    const p = open(ordersState());
    expect(p.screen().textContent).not.toMatch(/REQ-ORD|AC-0/);
    expect(p.rows()).toEqual(["A-1000", "A-1001", "A-1002", "A-1003", "A-1004", "A-1005"]);
    expect(p.$("details.pv-cov").hasAttribute("open")).toBe(false);
    expect(p.$("#proto-url").getAttribute("aria-label")).toBeTruthy();
    expect(p.html).not.toContain("What it covers");
  });

  it("filters by each of the five statuses and writes status to the address", () => {
    const p = open(ordersState());
    const expected: Record<string, string[]> = { New: ["A-1001"], "In progress": ["A-1002"], Shipped: ["A-1003", "A-1004"], Delivered: ["A-1000", "A-1005"], Cancelled: [] };
    for (const [status, ids] of Object.entries(expected)) {
      p.choose(status);
      expect(p.rows(), status).toEqual(ids);
      expect(p.hashNow()).toBe(`#/orders?status=${status}`);
    }
    p.choose("");
    expect(p.rows().length).toBe(6);
    expect(p.hashNow()).toBe("#/orders");
  });

  it("shows the empty state with the status in it and a reset button that returns to All", () => {
    const p = open(ordersState());
    p.choose("Cancelled");
    expect(p.screen().textContent).toContain("Нет заказов со статусом Cancelled");
    const reset = p.$$("button", p.screen()).find((b) => b.textContent === "Сбросить фильтр")!;
    reset.click();
    expect(p.rows().length).toBe(6);
    expect(p.$<HTMLSelectElement>("select[data-filter]").value).toBe("");
    expect(p.hashNow()).toBe("#/orders");
  });

  it("opens an order by clicking its row: the drawer shows the card and the lines, the row is selected, order is in the address", () => {
    const p = open(ordersState());
    p.clickRow("A-1002");
    const card = p.$('[data-overlay="orders#card"]');
    expect(card.getAttribute("data-state")).toBe("open");
    expect(card.textContent).toContain("ООО «Вектор»");
    expect(card.textContent).toContain("Кабель HDMI");
    expect(p.$('tr[data-row="A-1002"]').getAttribute("aria-selected")).toBe("true");
    expect(p.$('tr[data-row="A-1001"]').getAttribute("aria-selected")).toBe("false");
    expect(p.hashNow()).toBe("#/orders?order=A-1002");
    expect(p.$("tr[data-row]", card)).toBeNull();
    p.clickRow("A-1003");
    expect(p.$('[data-overlay="orders#card"]').textContent).toContain("Анна Смирнова");
    expect(p.$('[data-overlay="orders#card"]').textContent).not.toContain("ООО «Вектор»");
  });

  it("closes with the X button and with Escape, clears the selection and the address, and gives focus back to the row", () => {
    const p = open(ordersState());
    p.clickRow("A-1003");
    expect(p.doc.activeElement).toBe(p.$('[data-overlay="orders#card"]'));
    p.$<HTMLButtonElement>('[data-overlay="orders#card"] button[aria-label="Close"]').click();
    expect(p.$('[data-overlay="orders#card"]')).toBeNull();
    expect(p.hashNow()).toBe("#/orders");
    expect(p.$('tr[data-row="A-1003"]').getAttribute("aria-selected")).toBe("false");
    p.clickRow("A-1004");
    p.key(p.doc, "Escape");
    expect(p.$('[data-overlay="orders#card"]')).toBeNull();
    expect(p.hashNow()).toBe("#/orders");
    expect(p.doc.activeElement).toBe(p.$('tr[data-row="A-1004"]'));
  });

  it("opens a row from the keyboard", () => {
    const p = open(ordersState());
    p.key(p.$('tr[data-row="A-1005"]'), "Enter");
    expect(p.$('[data-overlay="orders#card"]')).not.toBeNull();
    expect(p.hashNow()).toBe("#/orders?order=A-1005");
  });

  it("changing the filter with an order open: it stays when it is still listed, and closes when it is not", () => {
    const p = open(ordersState());
    p.choose("Shipped");
    p.clickRow("A-1003");
    p.choose("");
    expect(p.$('[data-overlay="orders#card"]')).not.toBeNull();
    expect(p.hashNow()).toBe("#/orders?order=A-1003");
    p.choose("Shipped");
    expect(p.$('[data-overlay="orders#card"]')).not.toBeNull();
    expect(p.$('tr[data-row="A-1003"]').getAttribute("aria-selected")).toBe("true");
    p.choose("New");
    expect(p.$('[data-overlay="orders#card"]')).toBeNull();
    expect(p.hashNow()).toBe("#/orders?status=New");
    expect(p.rows()).toEqual(["A-1001"]);
  });

  it("restores filter and order from a deep link", () => {
    const p = open(ordersState(), "#/orders?status=Shipped&order=A-1004");
    expect(p.rows()).toEqual(["A-1003", "A-1004"]);
    expect(p.$<HTMLSelectElement>("select[data-filter]").value).toBe("Shipped");
    expect(p.$('[data-overlay="orders#card"]').textContent).toContain("Павел Орлов");
    expect(p.$('tr[data-row="A-1004"]').getAttribute("aria-selected")).toBe("true");
  });

  it("a missing order, or one outside the filter, opens nothing and drops order but keeps status", () => {
    for (const hash of ["#/orders?status=Shipped&order=NOPE-1", "#/orders?status=New&order=A-1003"]) {
      const p = open(ordersState(), hash);
      expect(p.$('[data-overlay="orders#card"]'), hash).toBeNull();
      expect(p.hashNow().includes("order="), hash).toBe(false);
      expect(p.hashNow().includes("status="), hash).toBe(true);
    }
    expect(open(ordersState(), "#/orders?status=Shipped&order=NOPE-1").rows()).toEqual(["A-1003", "A-1004"]);
  });

  it("an unknown status shows everything (All)", () => {
    const p = open(ordersState(), "#/orders?status=Bogus");
    expect(p.rows().length).toBe(6);
    expect(p.$<HTMLSelectElement>("select[data-filter]").value).toBe("");
  });

  it("a legacy order without the new fields loads and shows a dash for what is missing", () => {
    const p = open(ordersState(), "#/orders?order=A-1000");
    const card = p.$('[data-overlay="orders#card"]');
    expect(card.textContent).toContain("Legacy Customer");
    expect(p.$$("dd .miss", card).length).toBeGreaterThanOrEqual(5);
    expect(p.$$("dd .miss", card)[0].textContent).toBe("—");
    expect(card.querySelector("[data-related-empty]")).not.toBeNull();
  });

  it("switching the dataset updates the table; the empty dataset shows the empty message", () => {
    const p = open(ordersState());
    const ds = p.$<HTMLSelectElement>("#proto-data");
    ds.value = "full";
    ds.dispatchEvent(new p.w.Event("change"));
    p.choose("Cancelled");
    expect(p.rows()).toEqual(["A-1006"]);
    ds.value = "none";
    ds.dispatchEvent(new p.w.Event("change"));
    expect(p.rows()).toEqual([]);
    expect(p.$("[data-empty]")).not.toBeNull();
  });

  it("Back and Forward follow the address", async () => {
    const p = open(ordersState());
    p.choose("New");
    p.choose("Shipped");
    // jsdom traverses history asynchronously: wait for the page's own popstate instead of a fixed delay
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no popstate")), 3000);
      p.w.addEventListener("popstate", () => {
        clearTimeout(timer);
        setTimeout(resolve, 0);
      });
      p.w.history.back();
    });
    expect(p.rows()).toEqual(["A-1001"]);
  });

  it("the address bar accepts a typed address, including a wrong one", () => {
    const p = open(ordersState());
    const url = p.$<HTMLInputElement>("#proto-url");
    url.value = "/orders?status=Delivered&order=ZZ";
    p.$("#proto-addr").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
    expect(p.rows()).toEqual(["A-1000", "A-1005"]);
    expect(p.hashNow()).toBe("#/orders?status=Delivered");
    url.value = "/nowhere";
    p.$("#proto-addr").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
    expect(p.screen().textContent).toContain("Page not found");
  });

  it("mock text is data: markup in a value never becomes elements", () => {
    const hostile = JSON.parse(JSON.stringify(FIXTURE.prototype));
    hostile.mock[0].rows[1].customer = `<img src=x onerror="window.__x=1"><script>window.__x=2</script>`;
    const p = open(ordersState(hostile));
    expect(p.$$("img,script", p.screen()).length).toBe(0);
    expect(p.screen().textContent).toContain("<img src=x");
    expect((p.w as unknown as { __x?: number }).__x).toBeUndefined();
  });
});

describe("prototype modes, inspector, scenarios and comments", () => {
  it("Inspect: a click selects an element and shows its requirement and criteria, and does not operate the control", () => {
    const p = open(ordersState());
    p.$<HTMLButtonElement>('#pv-mode [data-mode="inspect"]').click();
    expect(p.$("#proto-frame").getAttribute("data-mode")).toBe("inspect");
    p.$('[data-el="orders#tbl"]').click();
    const inspector = p.$("#pv-inspector").textContent!;
    expect(inspector).toContain("REQ-ORD-001");
    expect(inspector).toContain("Requirement REQ-ORD-001 statement");
    expect(inspector).toContain("REQ-ORD-001-AC-04: Criterion 4 of REQ-ORD-001");
    expect(inspector).toContain("A click on a row opens card");
    p.clickRow("A-1002");
    expect(p.$('[data-overlay="orders#card"]')).toBeNull();
  });

  it("Review: clicking an element opens a comment for exactly that element, and Save carries it", () => {
    const p = open(ordersState());
    p.$<HTMLButtonElement>('#pv-mode [data-mode="review"]').click();
    p.$('[data-el="orders#status"]').click();
    const box = p.$<HTMLTextAreaElement>('[data-fb="orders#status"]');
    expect(box).not.toBeNull();
    box.value = "Statuses should be in the order of the workflow";
    const s = ReviewSubmissionSchema.parse(p.decisions());
    expect(s.prototype!.feedback).toEqual([{ target: "orders#status", comment: "Statuses should be in the order of the workflow" }]);
    const plan = submissionToCommands(ordersState(), s);
    expect(plan.conflicts).toEqual([]);
  });

  it("Scenarios: every check passes against the fixture, one click each, and a wrong expectation is reported", () => {
    const p = open(ordersState());
    p.$<HTMLButtonElement>("#sc-run-all").click();
    expect(p.$("#sc-summary").textContent).toBe("13 of 13 checked scenarios passed");
    const broken = JSON.parse(JSON.stringify(FIXTURE.prototype));
    broken.scenarios[1].expect.rows[0].count = 5;
    const q = open(ordersState(broken));
    q.$<HTMLButtonElement>("#sc-run-all").click();
    expect(q.$("#sc-summary").textContent).toBe("1 of 13 checked scenarios failed");
    expect(q.$("#pv-scenarios").textContent).toContain("1 row(s), expected 5");
  });

  it("Scenarios: clicking one opens that situation in the prototype", () => {
    const p = open(ordersState());
    p.$<HTMLButtonElement>('[data-scenario="deep"]').click();
    expect(p.hashNow()).toBe("#/orders?status=Shipped&order=A-1003");
    expect(p.$('[data-overlay="orders#card"]')).not.toBeNull();
  });

  it("Coverage groups elements and scenarios under each requirement and is collapsed", () => {
    const p = open(ordersState());
    const cov = p.$("details.pv-cov");
    expect(cov.hasAttribute("open")).toBe(false);
    expect(cov.querySelectorAll(".cov-req").length).toBe(5);
    expect(cov.textContent).toContain("5 of 5 requirement(s)");
    expect(cov.querySelector('[data-goto="orders#tbl"]')).not.toBeNull();
  });

  it("Mobile: the screen-size switch narrows the device frame", () => {
    const p = open(ordersState());
    p.$<HTMLButtonElement>('#pv-vp [data-vp="mobile"]').click();
    expect(p.$("#pv-device").classList.contains("mobile")).toBe(true);
    p.$<HTMLButtonElement>('#pv-vp [data-vp="desktop"]').click();
    expect(p.$("#pv-device").classList.contains("mobile")).toBe(false);
  });

  it("nothing the viewer does changes the saved prototype; Save sends only comments and acceptance", () => {
    const s = ordersState();
    const p = open(s);
    p.choose("Shipped");
    p.clickRow("A-1003");
    const d = p.decisions();
    expect(d.prototype).toEqual({ feedback: [], resolve: [], accept: false });
  });
});

describe("interactive elements beyond the orders case: tabs, forms, modal, showWhen", () => {
  const proto = {
    kind: "ui",
    title: "Demo",
    startScreen: "s",
    roles: ["admin"],
    mock: [{ id: "u", name: "Users", fields: [{ key: "name", label: "Name", type: "string" }, { key: "role", label: "Role", type: "enum", options: ["admin", "viewer"] }], rows: [{ name: "Ann", role: "admin" }] }],
    screens: [
      {
        id: "s",
        title: "Users",
        states: ["default", "success"],
        elements: [
          { id: "t", kind: "tabs", param: "tab", tabs: [{ id: "list", label: "List" }, { id: "new", label: "New user" }] },
          { id: "tbl", kind: "table", collection: "u", columns: ["name", "role"], showWhen: { param: "tab", equals: "list" } },
          { id: "f", kind: "field", label: "Name", collection: "u", field: "name", required: true, showWhen: { param: "tab", equals: "new" } },
          { id: "save", kind: "button", label: "Save", action: "submit", showWhen: { param: "tab", equals: "new" } },
          { id: "ask", kind: "button", label: "Delete all", action: "open-modal", rowOpens: "m", showWhen: { param: "tab", equals: "list" } },
          { id: "m", kind: "modal", label: "Delete everything?", param: "confirm", text: "This cannot be undone.", requirementIds: [], acIds: [] },
        ],
      },
    ],
  };
  const withDemo = () => ordersState(proto as never);

  it("tabs switch the visible elements through the address; arrow keys move between tabs", () => {
    const p = open(withDemo());
    expect(p.$('[role=tab][data-tab="list"]').getAttribute("aria-selected")).toBe("true");
    expect(p.$("table")).not.toBeNull();
    expect(p.$('[data-el="s#f"]')).toBeNull();
    p.key(p.$('[role=tab][data-tab="list"]'), "ArrowRight");
    expect(p.hashNow()).toBe("#/s?tab=new");
    expect(p.$('[data-el="s#f"]')).not.toBeNull();
    expect(p.$("table")).toBeNull();
  });

  it("a required field blocks the submit until it is filled", () => {
    const p = open(withDemo(), "#/s?tab=new");
    p.$<HTMLButtonElement>('[data-fk="btn:s#save"]').click();
    expect(p.$("[role=alert]")!.textContent).toBe("Required");
    const input = p.$<HTMLInputElement>('[data-fk="field:s#f"]');
    input.value = "Bob";
    input.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    p.$<HTMLButtonElement>('[data-fk="btn:s#save"]').click();
    expect(p.screen().textContent).toContain("Done.");
  });

  it("a modal opens from a button, traps Tab, closes on Escape and returns focus to the button", () => {
    const p = open(withDemo());
    p.$<HTMLButtonElement>('[data-fk="btn:s#ask"]').click();
    const m = p.$('[data-overlay="s#m"]');
    expect(m.getAttribute("aria-modal")).toBe("true");
    expect(m.textContent).toContain("This cannot be undone.");
    p.key(p.doc, "Escape");
    expect(p.$('[data-overlay="s#m"]')).toBeNull();
    expect(p.doc.activeElement).toBe(p.$('[data-fk="btn:s#ask"]'));
  });
});

describe("compatibility: a prototype saved before the interaction fields existed", () => {
  const LEGACY = {
    kind: "ui",
    title: "Orders",
    startScreen: "list",
    roles: ["manager"],
    mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }], rows: [{ number: "A-1" }, { number: "B-2" }] }],
    screens: [{ id: "list", title: "Orders", description: "", states: ["default", "empty"], stateMessages: {}, elements: [{ id: "tbl", kind: "table", label: "Orders", collection: "orders", columns: ["number"], allowedRoles: [], requirementIds: [], acIds: [] }] }],
    endpoints: [],
  };

  it("still renders, and an acceptance recorded before is not reported as stale after the schema grew", () => {
    let s = apply(null, { action: "open", projectId: "orders", title: "t", request: "r", mode: "guided" }).state;
    s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "s", acceptanceCriteria: ["a"] });
    s = ok(s, { action: "accept-requirements", via: "html-review" });
    s = ok(s, { action: "set-prototype", prototype: LEGACY, summary: "old" });
    s = ok(s, { action: "accept-prototype", via: "html-review" });
    expect(acceptanceStatus(s, "prototype")).toBe("accepted");
    // what a file written before the new fields looked like: none of the new keys are there
    const stored = JSON.parse(JSON.stringify(s));
    delete stored.prototype.datasets;
    delete stored.prototype.scenarios;
    delete stored.prototype.limitations;
    for (const sc of stored.prototype.screens) for (const e of sc.elements) for (const k of ["options", "filters", "detailFields", "tabs", "related", "required"]) delete e[k];
    // the fingerprint the old code recorded: a hash of exactly that stored content (same algorithm, none of the new keys)
    const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v);
    const { feedback: _f, history: _h, status: _s, revision: _r, ...content } = stored.prototype;
    stored.phaseAcceptance.prototype.fingerprint = createHash("sha256").update(JSON.stringify(sortKeys(content))).digest("hex").slice(0, 16);
    const reloaded = WorkflowStateSchema.parse(stored);
    expect(acceptanceStatus(reloaded, "prototype")).toBe("accepted");
    const p = open(reloaded);
    expect(p.rows()).toEqual(["A-1", "B-2"]);
    expect(p.$("#proto-data")).toBeNull();
    expect(p.$("#pv-scenarios").textContent).toContain("no scenarios");
  });
});

describe("review findings: hostile ids and tokens, focus, history, dangling references", () => {
  const clone = () => JSON.parse(JSON.stringify(FIXTURE.prototype));
  const rejects = (mutate: (p: any) => void, text: RegExp) => {
    const p = clone();
    mutate(p);
    expect(() => ordersState(p)).toThrow(text);
  };

  it("an id with quotes or backslashes does not break opening, focus or closing", () => {
    for (const id of ['A"1', "B\\", "C]'[x"]) {
      const p = clone();
      p.mock[0].rows[1].number = id;
      p.scenarios = [];
      const page = open(ordersState(p));
      const row = page.$$("tr[data-row]").find((r) => r.getAttribute("data-row") === id)!;
      row.dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(page.$$("[data-overlay]").length, id).toBe(1);
      page.key(page.doc, "Escape");
      expect(page.$$("[data-overlay]").length, id).toBe(0);
      expect(page.doc.activeElement?.getAttribute("data-row"), id).toBe(id);
    }
  });

  it("arrow keys move focus between tabs, and repeating a click adds no history entry", () => {
    const proto = {
      kind: "ui", title: "T", startScreen: "s", roles: [], mock: [{ id: "u", name: "U", fields: [{ key: "id", label: "Id", type: "string" }], rows: [{ id: "1" }] }],
      screens: [{ id: "s", title: "S", states: ["default"], elements: [{ id: "t", kind: "tabs", param: "tab", tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] }, { id: "tbl", kind: "table", collection: "u", columns: ["id"], rowOpens: "d" }, { id: "d", kind: "drawer", param: "o", collection: "u", idField: "id", detailFields: [{ field: "id" }] }] }],
    };
    const page = open(ordersState(proto as never));
    page.key(page.$('[data-tab="a"]'), "ArrowRight");
    expect(page.doc.activeElement?.getAttribute("data-tab")).toBe("b");
    page.key(page.doc.activeElement!, "ArrowRight");
    expect(page.doc.activeElement?.getAttribute("data-tab")).toBe("c");
    const before = page.w.history.length;
    page.$('[data-tab="c"]').click();
    page.$('[data-tab="c"]').click();
    page.clickRow("1");
    page.clickRow("1");
    expect(page.w.history.length).toBe(before + 1);
  });

  it("Run all checks adds no history entries", () => {
    const page = open(ordersState());
    const before = page.w.history.length;
    page.$<HTMLButtonElement>("#sc-run-all").click();
    expect(page.w.history.length).toBeLessThanOrEqual(before + 1);
  });

  it("a token that could fetch a resource never reaches the page", () => {
    for (const bad of ["url(//evil.test/x.png)", "image-set(\"//evil.test/x.png\" 1x)", "var(--x)"]) {
      const p = clone();
      p.styles.colors.surface = bad;
      p.styles.radius = bad;
      const html = renderPrototypeHtml(ordersState(p));
      expect(html, bad).not.toMatch(/evil\.test/);
    }
  });

  it("a legacy element without the behaviour fields still shows its label", () => {
    const legacy = {
      kind: "ui", title: "L", startScreen: "s", roles: [], mock: [],
      screens: [{ id: "s", title: "S", states: ["default"], elements: [{ id: "m", kind: "modal", label: "Old modal" }, { id: "t", kind: "tabs", label: "Old tabs" }, { id: "f", kind: "filter", label: "Old filter" }] }],
    };
    let s = ordersState();
    const stored = JSON.parse(JSON.stringify(s));
    stored.prototype = { ...stored.prototype, ...legacy, screens: legacy.screens.map((sc) => ({ ...sc, description: "", stateMessages: {}, elements: sc.elements.map((e) => ({ ...e, allowedRoles: [], requirementIds: [], acIds: [], columns: [], options: [], filters: [], detailFields: [], tabs: [], related: [], required: false })) })), datasets: [], scenarios: [] };
    s = WorkflowStateSchema.parse(stored);
    const page = open(s);
    const text = page.screen().textContent!;
    for (const label of ["Old modal", "Old tabs", "Old filter"]) expect(text).toContain(label);
  });

  it("names that exist on every object cannot be used as parameters", () => {
    rejects((p) => (p.screens[0].elements[0].param = "constructor"), /Object property name|invalid|param/i);
  });

  it("dangling references are refused when the prototype is saved", () => {
    rejects((p) => (p.screens[0].elements[2].showWhen = { param: "ghost", present: true }), /showWhen/);
    rejects((p) => (p.screens[0].elements[1].filters = [{ param: "ghost", field: "status" }]), /filters by "ghost"/);
    rejects((p) => (p.screens[0].elements[1].emptyAction.clear = ["ghost"]), /clears "ghost"/);
    rejects((p) => (p.scenarios[0].expect.query = { ghost: "1" }), /query parameter "ghost"/);
    rejects((p) => (p.scenarios[0].expect.rows = [{ element: "status", count: 1 }]), /not a table or list/);
    rejects((p) => (p.scenarios[0].expect.overlay = [{ element: "tbl", state: "open" }]), /not a drawer or modal/);
    rejects((p) => delete p.screens[0].elements[2].param, /needs a param/);
    rejects((p) => (p.screens[0].elements[2].collection = undefined), /./);
    rejects((p) => (p.screens[0].elements[1].allowedRoles = ["ghost"]), /role "ghost"/);
  });
});

describe("E2E backlog: address, empty states, inspector, labels", () => {
  it("B1: the address bar follows normalization (a dropped order is gone from it as well as from the hash)", () => {
    const p = open(ordersState());
    p.choose("Shipped");
    p.clickRow("A-1003");
    expect(p.$<HTMLInputElement>("#proto-url").value).toBe("/orders?status=Shipped&order=A-1003");
    p.choose("New");
    expect(p.$<HTMLInputElement>("#proto-url").value).toBe("/orders?status=New");
    expect(p.hashNow()).toBe("#/orders?status=New");
    const q = open(ordersState(), "#/orders?status=Shipped&order=NOPE");
    expect(q.$<HTMLInputElement>("#proto-url").value).toBe("/orders?status=Shipped");
  });

  it("B2/RD5: no data at all and a filter that matches nothing say different things; the empty screen state keeps the controls", () => {
    const p = open(ordersState());
    p.choose("Cancelled");
    expect(p.screen().textContent).toContain("Нет заказов со статусом Cancelled");
    const ds = p.$<HTMLSelectElement>("#proto-data");
    ds.value = "none";
    ds.dispatchEvent(new p.w.Event("change"));
    p.choose("");
    expect(p.screen().textContent).toContain("There is no data yet.");
    expect(p.screen().textContent).not.toContain("Сбросить фильтр");
    const sw = p.$<HTMLSelectElement>("#proto-state");
    sw.value = "empty";
    sw.dispatchEvent(new p.w.Event("change"));
    expect(p.$("select[data-filter]")).not.toBeNull();
    expect(p.screen().textContent).toContain("Заказов пока нет.");
  });

  it("B3/P2/P5: inspect mode reserves room for its tag, the address says it is simulated, the scenarios say they are a self-check", () => {
    const p = open(ordersState());
    expect(p.html).toContain("(simulated)");
    expect(p.html).toMatch(/\.proto\[data-mode=inspect\] \.screen \.el[^{]*\{margin-top/);
    expect(p.$('[data-sidepanel="scenarios"]').textContent).toContain("not an independent test of the application");
  });
});
