// @vitest-environment node
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, customFrameDocument, CUSTOM_FRAME_CSP, explainCommandError, expectedCapabilities, prototypeFingerprint, renderReview, submissionToCommands, ReviewSubmissionSchema, type WorkflowState } from "./index.js";

/**
 * Interface patterns that are not tables: the agronomist journal (an anonymized reproduction of an external report, where a requested
 * chat was delivered as a table with a "Side in Chat" column) and a sandboxed custom part. The acceptance criteria of the report are
 * written down as checks of the rendered page and run against both the reported table and the conversation element.
 */
const F = JSON.parse(readFileSync(new URL("./__fixtures__/agronomist-journal.json", import.meta.url), "utf8"));
const ORDERS = JSON.parse(readFileSync(new URL("./__fixtures__/orders-interactive.command.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-10T09:00:00.000Z");
const ME = "Ирина Ковалёва";
const apply = (s: WorkflowState | null, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW, channel: { via: "html-review" } }).state;
type Proto = Record<string, any>;
type El = Record<string, any>;

function base(): WorkflowState {
  let s = apply(apply(null, F.open), F.repository);
  for (const r of F.requirements) s = apply(s, { action: "add-requirement", ...r });
  return apply(apply(s, F.impact), { action: "accept-requirements", via: "html-review" });
}
/** The journal screen: the existing elements in their order, with the note feed (id "feed") replaced by the given element. */
const screen = (feed: El | null, extra: El[] = []) => ({ ...F.screen, elements: [...F.existing.map((e: El) => (e.id === "feed" && feed ? feed : e)), ...extra] });
const ACTIVE = F.mock.notes.rows.filter((n: El) => n.status === "active");
const common = (mock: El[]) => ({ kind: "ui", title: "Журнал агронома", startScreen: "journal", styles: F.styles, mock, datasets: F.datasets });
function chat(patch: (p: Proto) => void = () => {}): Proto {
  const p: Proto = JSON.parse(JSON.stringify({ ...common([F.mock.notes, F.mock.attachments]), screens: [screen(F.chat.feed)], scenarios: F.chat.scenarios, limitations: ["Голосовые заметки — имитация без звука."] }));
  patch(p);
  return p;
}
/** The journal as it is today: the same screen with its own note feed. */
const existing = (): Proto => JSON.parse(JSON.stringify({ ...common([F.mock.notes, F.mock.attachments]), screens: [screen(null)] }));
/** The prototype from the report, rebuilt: the same notes as table rows, with the side of the chat as a column. */
function reported(): Proto {
  const rows = F.mock.notes.rows.map((n: El) => ({ id: n.id, author: n.author, side: n.author === ME ? "Исходящее" : "Входящее", created: n.createdAt.slice(11), voice: n.voice ? `Да (${n.voice} с)` : "Нет", text: n.text, attachments: F.mock.attachments.rows.filter((a: El) => a.noteId === n.id).map((a: El) => a.name).join(", ") || null, date: n.createdAt.slice(0, 10), field: n.field, kind: n.kind, status: n.status }));
  const s = screen(F.reported.feed);
  s.elements = s.elements.map((e: El) => (e.id === "card" ? { ...e, detailFields: [{ field: "date" }, { field: "created" }, { field: "author" }, { field: "text" }] } : e));
  return { ...common([{ ...F.reported.mock, rows }, F.mock.attachments]), notes: F.reported.notes, screens: [s] };
}
/** The composer of the conversation element, which this fixture does not use (the journal keeps its own form): tested on its own. */
const withComposer = (p: Proto) => (p.screens[0].elements.find((e: El) => e.id === "feed").conversation.composer = { placeholder: "Новая запись…", sendLabel: "Отправить", values: { role: "агроном", kind: "Наблюдение", status: "active" } });
const withProto = (p: Proto) => apply(base(), { action: "set-prototype", prototype: p, summary: "test" });

function open(state: WorkflowState, hash = "") {
  const html = renderReview(state, "prototype", { token: "t0k" });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: `https://review.test/p${hash}` });
  const w = dom.window;
  const doc = w.document;
  const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = doc) => root.querySelector(sel) as T;
  const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = doc) => [...root.querySelectorAll(sel)] as T[];
  const feed = () => $('[data-el="journal#feed"]');
  const msgs = () => $$<HTMLElement>("li.cv-msg", feed() ?? doc);
  const ids = () => msgs().map((m) => m.getAttribute("data-row"));
  const choose = (param: string, value: string) => {
    const sel = $<HTMLSelectElement>(`select[data-filter="${param}"]`);
    sel.value = value;
    sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const mode = (m: string) => $<HTMLButtonElement>(`#pv-mode button[data-mode="${m}"]`).click();
  const decisions = () => {
    $("#btn-copy").click();
    return JSON.parse($<HTMLTextAreaElement>("#out textarea").value);
  };
  return { dom, w, doc, html, $, $$, feed, msgs, ids, choose, mode, decisions, hashNow: () => decodeURIComponent(w.location.hash) };
}

/** The acceptance scenario of the report, as checks of what the page actually shows. Returns the criteria that fail. */
function chatAcceptance(p: ReturnType<typeof open>): string[] {
  const fail: string[] = [];
  const feed = p.feed();
  if (!feed) return ["the note feed is missing"];
  const kept = ["status", "byField", "byKind", "find", "newNote", "newText", "newField", "newKind", "attach", "record", "addNote"].every((id) => p.$(`[data-el="journal#${id}"]`));
  if (!kept || p.$$('[data-el="journal#status"] button[role=tab]').map((b) => b.textContent).join() !== "Актуальные,Архивные") fail.push("the existing header and controls remain");
  if (feed.querySelector("table, tr, th")) fail.push("the feed is NOT a table");
  const m = p.msgs();
  if (m.length !== ACTIVE.length || !m.every((x) => x.querySelector(".cv-b"))) fail.push("notes render as message bubbles");
  const times = m.map((x) => (x.querySelector("time")?.getAttribute("datetime") ?? ""));
  if (times.join() !== [...times].sort().join()) fail.push("the bubbles are chronological");
  const sideOf = (id: string) => m.find((x) => x.getAttribute("data-row") === id)?.getAttribute("data-side");
  if (ACTIVE.some((n: El) => sideOf(n.id) !== (n.author === ME ? "out" : "in"))) fail.push("incoming align left, outgoing align right");
  const firsts = m.filter((x) => x.classList.contains("first"));
  if (!firsts.length || !firsts.every((x) => x.querySelector(".cv-who")?.textContent === x.getAttribute("data-author")) || !m.every((x) => /^\d{2}:\d{2}$/.test(x.querySelector("time")?.textContent ?? ""))) fail.push("author and timestamp are readable");
  const voice = m.find((x) => x.getAttribute("data-row") === "N-105");
  if (!voice?.querySelector("button.cv-play") || !/mock/i.test(voice.textContent ?? "")) fail.push("voice messages have a playback control, marked as a mock");
  const att = m.find((x) => x.getAttribute("data-row") === "N-107");
  if ((att?.querySelectorAll("[data-att]").length ?? 0) !== 2) fail.push("attachments are represented");
  if (p.$$(".cv-day", feed).length !== 3) fail.push("dates are grouped by day");
  return fail;
}

describe("the reported failure, reproduced", () => {
  it("before this change a chat could not be declared: the kind is refused, and the refusal now says what to use instead of a table", () => {
    const p = chat((x) => (x.screens[0].elements.find((e: El) => e.id === "feed").kind = "chat"));
    let message = "";
    try {
      withProto(p);
    } catch (error) {
      message = explainCommandError(error) ?? String(error);
    }
    expect(message).toMatch(/received 'chat'/);
    expect(message).toMatch(/kind conversation/);
    expect(message).toMatch(/kind custom/);
    expect(message).toMatch(/Never show such a pattern as a table/);
  });

  it("the reported table fails the acceptance scenario; the conversation element passes every criterion", () => {
    const table = open(withProto(reported()));
    expect(table.$$("th", table.feed()).map((t) => t.textContent)).toEqual(["Author", "Side in Chat", "Created", "Voice", "Text", "Attachments", "Date"]);
    const failed = chatAcceptance(table);
    expect(failed).toContain("the feed is NOT a table");
    expect(failed).toContain("notes render as message bubbles");
    expect(chatAcceptance(open(withProto(chat())))).toEqual([]);
  });
});

describe("conversation: rows of a mock collection as a chat", () => {
  it("orders messages by time whatever the data order, with a separator per day in the prototype's language", () => {
    const shuffled = chat((p) => (p.mock[0].rows = [...p.mock[0].rows].reverse()));
    const p = open(withProto(shuffled));
    expect(p.ids()).toEqual(ACTIVE.map((n: El) => n.id));
    expect(p.$$(".cv-day", p.feed()).map((d) => d.textContent)).toEqual(["12 мая 2026 г.", "13 мая 2026 г.", "14 мая 2026 г."]);
    // the separator comes right before the first message of its day
    expect(p.$('li[data-row="N-105"]').previousElementSibling?.textContent).toBe("13 мая 2026 г.");
  });

  it("aligns the current user's messages right and the others left, and groups consecutive messages of one author", () => {
    const p = open(withProto(chat()));
    const m = (id: string) => p.$(`li[data-row="${id}"]`);
    expect(m("N-103").className).toContain("out");
    expect(m("N-104").className).toContain("in");
    // N-102 follows N-101 by the same author two minutes later: one group, the author shown once
    expect(m("N-101").classList.contains("first")).toBe(true);
    expect(m("N-102").classList.contains("first")).toBe(false);
    expect(m("N-102").querySelector(".cv-who")).toBeNull();
    // the same author after more than five minutes starts a new group
    expect(m("N-112").classList.contains("first")).toBe(true);
    expect(m("N-111").classList.contains("first")).toBe(false);
    expect(m("N-101").querySelector(".cv-av")?.textContent).toBe("ПС");
    expect(m("N-101").querySelector("time")?.textContent).toBe("07:40");
    expect(m("N-101").querySelector(".cv-tag")?.textContent).toBe("Наблюдение");
  });

  it("shows voice messages with a mock player that plays and stops in place, and a voice-only message without text", () => {
    const p = open(withProto(chat()));
    const voice = p.$('li[data-row="N-105"]');
    const play = voice.querySelector("button.cv-play") as HTMLButtonElement;
    expect(play.getAttribute("aria-label")).toBe("Play voice message (0:42, mock: no audio)");
    expect(voice.querySelector(".cv-dur")?.textContent).toBe("0:42");
    expect(voice.querySelector(".cv-text")?.textContent).toContain("очаги тли");
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("true");
    expect(voice.querySelector(".cv-voice")?.hasAttribute("data-playing")).toBe(true);
    expect(p.$('li[data-row="N-105"]')).toBe(voice); // no re-render: the feed keeps its scroll position
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("false");
    expect(p.hashNow()).not.toContain("note="); // the player does not open the card
    const only = p.$('li[data-row="N-112"]');
    expect(only.querySelector(".cv-voice")).not.toBeNull();
    expect(only.querySelector(".cv-text")).toBeNull();
    expect(only.querySelector(".miss")).toBeNull();
  });

  it("shows photos and documents with their name and size", () => {
    const p = open(withProto(chat()));
    const photos = p.$$('li[data-row="N-102"] [data-att-kind="photo"]');
    expect(photos.map((x) => x.querySelector("figcaption")?.textContent)).toEqual(["pole3-kray-1.jpg · 2,4 МБ", "pole3-kray-2.jpg · 2,1 МБ"]);
    const doc = p.$('li[data-row="N-104"] [data-att-kind="document"]');
    expect(doc.querySelector(".cv-ext")?.textContent).toBe("PDF");
    expect(doc.textContent).toContain("analiz-pochvy-pole3.pdf");
    expect(doc.textContent).toContain("340 КБ");
  });

  it("keeps the journal's filters, search and tabs working on the feed, with the values in the address", () => {
    const p = open(withProto(chat()));
    p.choose("field", "Поле 7");
    expect(p.ids()).toEqual(["N-105", "N-106", "N-107", "N-108", "N-109"]);
    expect(p.hashNow()).toBe("#/journal?field=Поле 7");
    p.choose("type", "Обработка");
    expect(p.ids()).toEqual(["N-108", "N-109"]);
    p.choose("field", "Поле 12");
    expect(p.ids()).toEqual([]);
    expect(p.feed().textContent).toContain("Нет записей по выбранным условиям.");
    p.$$<HTMLButtonElement>("button", p.feed()).find((b) => b.textContent === "Сбросить фильтры")!.click();
    expect(p.ids().length).toBe(12);
    expect(p.hashNow()).toBe("#/journal");
    const box = p.$<HTMLInputElement>("[data-search]");
    box.focus();
    box.value = "известкование";
    box.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    expect(p.ids()).toEqual(["N-110"]);
    expect(p.doc.activeElement).toBe(box); // the search box is never rebuilt
    box.value = "";
    box.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    p.$<HTMLButtonElement>('button[data-tab="archived"]').click();
    expect(p.ids()).toEqual(["N-090", "N-091", "N-092"]);
    expect(p.hashNow()).toBe("#/journal?status=archived");
    expect(p.$$(".cv-day", p.feed()).map((d) => d.textContent)).toEqual(["20 апреля 2026 г.", "22 апреля 2026 г."]);
    p.$<HTMLButtonElement>('button[data-tab="active"]').click();
    expect(p.ids().length).toBe(12);
  });

  it("opens the note card from a message, by click and from the keyboard, and restores it from a deep link", () => {
    const p = open(withProto(chat()));
    p.$('li[data-row="N-104"]').click();
    const card = p.$('[data-overlay="journal#card"]');
    expect(card.getAttribute("data-state")).toBe("open");
    expect(card.textContent).toContain("analiz-pochvy-pole3.pdf");
    expect(p.$('li[data-row="N-104"]').getAttribute("aria-current")).toBe("true");
    expect(p.hashNow()).toBe("#/journal?note=N-104");
    p.$<HTMLButtonElement>('[data-overlay="journal#card"] button[aria-label="Close"]').click();
    expect(p.doc.activeElement).toBe(p.$('li[data-row="N-104"]'));
    p.$('li[data-row="N-109"]').dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(p.hashNow()).toBe("#/journal?note=N-109");
    const deep = open(withProto(chat()), "#/journal?field=Поле 7&note=N-107");
    expect(deep.$('[data-overlay="journal#card"]').textContent).toContain("skhema-ochagov.png");
  });

  it("its own composer (not used by this journal) adds an outgoing message at the end, in the filtered feed, without touching the saved prototype", () => {
    const state = withProto(chat(withComposer));
    const before = JSON.stringify(state.prototype);
    const p = open(state);
    p.choose("field", "Поле 7");
    const input = p.$<HTMLInputElement>('[data-fk="compose:journal#feed"]');
    input.value = "Проверю краевые ряды через три дня.";
    input.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    input.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const last = p.msgs().at(-1)!;
    expect(last.getAttribute("data-side")).toBe("out");
    expect(last.getAttribute("data-author")).toBe(ME);
    expect(last.textContent).toContain("Проверю краевые ряды через три дня.");
    expect(p.ids().length).toBe(6); // it carries the active filter, so it stays in this feed
    expect(p.$<HTMLInputElement>('[data-fk="compose:journal#feed"]').value).toBe("");
    expect(p.doc.activeElement?.getAttribute("data-fk")).toBe("compose:journal#feed");
    expect(JSON.stringify(state.prototype)).toBe(before);
    p.$<HTMLButtonElement>("#proto-reset").click();
    expect(p.ids().length).toBe(5);
  });

  it("runs its scenarios in the page, shows the empty journal and the screen states", () => {
    const p = open(withProto(chat()));
    p.$<HTMLButtonElement>('[data-side="scenarios"]').click();
    p.$<HTMLButtonElement>("#sc-run-all").click();
    expect(p.$("#sc-summary").textContent).toBe("7 of 7 checked scenarios passed");
    const ds = p.$<HTMLSelectElement>("#proto-data");
    ds.value = "empty";
    ds.dispatchEvent(new p.w.Event("change"));
    expect(p.feed().textContent).toContain("В журнале пока нет записей.");
    const st = p.$<HTMLSelectElement>("#proto-state");
    st.value = "loading";
    st.dispatchEvent(new p.w.Event("change"));
    expect(p.$("#proto-screen").textContent).toContain("Загружаем записи…");
  });

  it("is inspected and commented on like any element, and the comment and acceptance are saved through the usual submission", () => {
    const state = withProto(chat());
    const p = open(state);
    p.mode("inspect");
    p.$('li[data-row="N-105"]').click();
    const inspector = p.$("#pv-inspector").textContent ?? "";
    expect(inspector).toContain("REQ-JRN-001");
    expect(inspector).toContain("REQ-JRN-002-AC-01");
    expect(inspector).toMatch(/Outgoing \(right\) when "author" is Ирина Ковалёва/);
    expect(inspector).toContain("mock player, no audio");
    expect(p.hashNow()).not.toContain("note="); // Inspect does not operate the prototype
    p.mode("review");
    p.$('li[data-row="N-105"]').click();
    const ta = p.$<HTMLTextAreaElement>('textarea[data-fb="journal#feed"]');
    ta.value = "Покажите расшифровку свёрнутой";
    p.$<HTMLInputElement>("#accept-proto").checked = true;
    const raw = p.decisions();
    expect(raw.prototype).toEqual({ feedback: [{ target: "journal#feed", comment: "Покажите расшифровку свёрнутой" }], resolve: [], accept: true });
    const plan = submissionToCommands(state, ReviewSubmissionSchema.parse(raw));
    let next = state;
    for (const command of plan.commands) next = apply(next, command);
    expect(next.prototype?.feedback[0].target).toBe("journal#feed");
    expect(next.phaseAcceptance.prototype?.fingerprint).toBe(prototypeFingerprint(next.prototype));
    expect(next.prototype?.revision).toBe(1);
  });

  it("asks for a create story when the composer adds messages", () => {
    // the journal's own form already asks for one for REQ-JRN-003; the composer asks for one for the feed's requirements too
    expect(expectedCapabilities(withProto(chat()), withProto(chat()).requirements.find((r) => r.id === "REQ-JRN-001")!)).not.toContain("create");
    const state = withProto(chat(withComposer));
    expect(expectedCapabilities(state, state.requirements.find((r) => r.id === "REQ-JRN-001")!)).toEqual(expect.arrayContaining(["view", "create"]));
  });

  it("refuses settings that would render a broken feed", () => {
    const feed = (patch: (e: El) => void) => chat((p) => patch(p.screens[0].elements.find((e: El) => e.id === "feed")));
    expect(() => withProto(feed((e) => (e.conversation.authorField = "writer")))).toThrow(/authorField "writer" is not a field of mock collection notes/);
    expect(() => withProto(feed((e) => delete e.conversation))).toThrow(/needs conversation settings/);
    expect(() => withProto(feed((e) => (e.conversation.attachments.nameField = "file")))).toThrow(/attachment field "file"/);
    expect(() => withProto(feed((e) => ((e.conversation.outgoingValues = []), (e.conversation.composer = { values: {} }))))).toThrow(/cannot tell who writes a new message/);
    expect(() => withProto(chat((p) => (p.mock[0].rows[0].createdAt = "12.05.2026 07:40")))).toThrow(/time "12.05.2026 07:40" .* is not YYYY-MM-DD/);
    expect(() => withProto(chat((p) => (p.mock[0].rows[0].voice = "долго")))).toThrow(/voice "долго"/);
    expect(() => withProto(chat((p) => (p.screens[0].elements.find((e: El) => e.id === "card").conversation = F.chat.feed.conversation)))).toThrow(/has conversation settings but is a drawer/);
  });
});

describe("only the note feed changes: the journal around it is kept as it is", () => {
  const rowIds = (p: ReturnType<typeof open>) => p.$$('[data-el="journal#feed"] [data-row]').map((r) => r.getAttribute("data-row")).sort();
  /** Everything on the screen except the feed: the header and every element wrapper, as HTML. */
  const around = (p: ReturnType<typeof open>) => [...p.$$("#proto-screen > h2, #proto-screen > p.lead"), ...p.$$("#proto-screen > [data-el]").filter((n) => n.getAttribute("data-el") !== "journal#feed")].map((n) => n.outerHTML);

  it("the chat prototype has the existing elements in their order, and only the feed is different; the feed keeps its data, filters, card and empty states", () => {
    const before = withProto(existing()).prototype!.screens[0].elements;
    const after = withProto(chat()).prototype!.screens[0].elements;
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after.filter((e, i) => JSON.stringify(e) !== JSON.stringify(before[i])).map((e) => e.id)).toEqual(["feed"]);
    const [was, now] = [before, after].map((list) => list.find((e) => e.id === "feed")!);
    for (const key of ["collection", "idField", "rowOpens", "filters", "emptyText", "noDataText", "emptyAction", "showWhen", "allowedRoles"] as const) expect(now[key], key).toEqual(was[key]);
    expect([was.kind, now.kind]).toEqual(["list", "conversation"]);
    // the journal keeps its own note form, so the conversation has no second one
    expect(now.conversation?.composer).toBeUndefined();
    expect(after.map((e) => e.kind)).toEqual(["tabs", "filter", "filter", "search", "form", "field", "field", "field", "button", "button", "button", "conversation", "drawer"]);
  });

  it("renders the header, the Актуальные / Архивные tabs, the filters, the search, the note form and its buttons exactly as before; the feed becomes bubbles", () => {
    const a = open(withProto(existing()));
    const b = open(withProto(chat()));
    expect(around(b)).toEqual(around(a));
    expect(around(a).length).toBe(13); // the title and the farm line, and 11 controls (the card is closed)
    expect(a.$$('[data-el="journal#status"] button[role=tab]').map((t) => t.textContent)).toEqual(["Актуальные", "Архивные"]);
    expect(a.$$('[data-el="journal#feed"] tr[data-row]').length).toBe(12);
    expect(a.$$('[data-el="journal#feed"] li.cv-msg').length).toBe(0);
    expect(b.$$('[data-el="journal#feed"] li.cv-msg').length).toBe(12);
    expect(b.$('[data-el="journal#feed"] table')).toBeNull();
  });

  it("the tabs, filters, search, note form and card behave the same around the old and the new feed", () => {
    const observe = (p: ReturnType<typeof open>) => {
      const seen: unknown[] = [];
      const note = (what: string) => seen.push([what, rowIds(p), around(p)]);
      p.$<HTMLButtonElement>('button[data-tab="archived"]').click();
      note("archived");
      p.$<HTMLButtonElement>('button[data-tab="active"]').click();
      p.choose("field", "Поле 7");
      note("field");
      p.choose("type", "Задача");
      note("field and type");
      p.choose("field", "");
      p.choose("type", "");
      const box = p.$<HTMLInputElement>("[data-search]");
      box.value = "известкование";
      box.dispatchEvent(new p.w.Event("input", { bubbles: true }));
      seen.push(["search", rowIds(p)]);
      box.value = "";
      box.dispatchEvent(new p.w.Event("input", { bubbles: true }));
      // the note form: a missing text is refused, a filled one is confirmed, as before
      p.$<HTMLButtonElement>('[data-fk="btn:journal#addNote"]').click();
      seen.push(["empty form", p.$('[data-el="journal#newText"]').textContent, p.$$('[role="alert"]').length]);
      const text = p.$<HTMLInputElement>('[data-fk="field:journal#newText"]');
      text.value = "Осмотр поля 12";
      text.dispatchEvent(new p.w.Event("input", { bubbles: true }));
      const fieldSel = p.$<HTMLSelectElement>('[data-fk="field:journal#newField"]');
      fieldSel.value = "Поле 12";
      fieldSel.dispatchEvent(new p.w.Event("change", { bubbles: true }));
      p.$<HTMLButtonElement>('[data-fk="btn:journal#addNote"]').click();
      seen.push(["filled form", p.$("#proto-screen").textContent?.includes("Saved (mock data only)."), p.$$('[role="alert"]').length]);
      // the card
      p.w.location.hash = "#/journal?note=N-104";
      p.w.dispatchEvent(new p.w.HashChangeEvent("hashchange"));
      seen.push(["card", p.$('[data-overlay="journal#card"]').outerHTML]);
      return seen;
    };
    const was = observe(open(withProto(existing())));
    const now = observe(open(withProto(chat())));
    expect(now).toEqual(was);
    expect(was[0]).toEqual(["archived", ["N-090", "N-091", "N-092"], expect.any(Array)]);
    expect((was[3] as unknown[])[1]).toEqual(["N-110"]);
    expect((was[4] as unknown[])[2]).toBe(1);
    expect(was[5]).toEqual(["filled form", true, 0]);
  });
});

const CUSTOM: El = {
  id: "board",
  kind: "custom",
  label: "Доска задач по полям",
  collection: "notes",
  filters: [{ param: "field", field: "field" }],
  custom: {
    reason: "A board with a column per field and drag-like cards: no structured element shows columns of cards.",
    html: '<div id="cols"></div><p data-praxis-part="legend">Легенда</p>',
    css: "#cols{display:flex;gap:8px}",
    script: "praxis.onData=function(d){document.getElementById('cols').textContent=d.rows.notes.length+' notes'};var s='</script><b>still inside</b>';",
    height: 300,
    parts: [
      { id: "legend", label: "Легенда доски", requirementIds: ["REQ-JRN-003"], acIds: ["REQ-JRN-003-AC-01"] },
      { id: "column", label: "Колонка поля", acIds: ["REQ-JRN-001-AC-03"] },
    ],
  },
};
const withCustom = (patch: (e: El) => void = () => {}) => {
  const el = JSON.parse(JSON.stringify(CUSTOM));
  patch(el);
  return withProto(chat((p) => p.screens[0].elements.push(el)));
};

describe("custom: a sandboxed part for patterns no element represents", () => {
  it("builds the frame document with its own policy first and the part's code after it, with no way out of its script", () => {
    const doc = customFrameDocument({ html: "<p>x</p>", css: "a{}</style><script>alert(1)</script>", script: "var s='</script><img src=x>'" }, "--p-primary:#2f7d32");
    expect(doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${CUSTOM_FRAME_CSP}">`)).toBeGreaterThan(0);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>x</p>"));
    expect(CUSTOM_FRAME_CSP).toMatch(/default-src 'none'/);
    expect(CUSTOM_FRAME_CSP).toMatch(/connect-src 'none'/);
    expect(doc).toContain("var s='<\\/script><img src=x>'");
    expect(doc).toContain("a{}<\\/style>");
  });

  it("renders a frame sandboxed to scripts only; the page holds its code only as data and never its token in the frame", () => {
    const p = open(withCustom());
    const frame = p.$<HTMLIFrameElement>('iframe[data-frame="journal#board"]');
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("style")).toBe("height:300px");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc.startsWith("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(srcdoc).not.toContain("t0k");
    expect(srcdoc).not.toContain("praxis-data");
    // the markup is never part of the page itself: only inside the frame's document (and once, as JSON data)
    expect(p.$("#cols")).toBeNull();
    expect(p.html.split('data-praxis-part=\\"legend\\"').length - 1).toBe(1);
    expect(p.$('[data-el="journal#board"]').getAttribute("data-tag")).toMatch(/^custom \(sandboxed\)/);
    // the page's own caption, outside the frame, says that nothing inside it can decide anything
    expect(p.$('[data-custom-cap="journal#board"]').textContent).toContain("they cannot save, comment or accept");
    expect(p.$('[data-custom-cap="journal#board"]').nextElementSibling).toBe(frame);
  });

  it("every review page carries its own policy, so the offline copy is as strict as the served one", () => {
    const policy = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1].replace(/&#39;/g, "'");
    const offline = renderReview(withCustom(), "prototype", {});
    expect(policy(offline)).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'");
    const served = renderReview(withCustom(), "prototype", { saveUrl: "http://127.0.0.1:41234/r/abc/submit", token: "t" });
    expect(policy(served)).toContain("connect-src http://127.0.0.1:41234;");
    expect(offline.indexOf("Content-Security-Policy")).toBeLessThan(offline.indexOf("<style>"));
    expect(policy(renderReview(base(), "requirements", {}))).toContain("default-src 'none'");
  });

  it("accepts from the frame only a declared part, only in Inspect or Review, only with the focus, rate-limited", async () => {
    const p = open(withCustom());
    const frame = p.$<HTMLIFrameElement>('iframe[data-frame="journal#board"]');
    const post = (data: unknown, source: unknown = frame.contentWindow) => p.w.dispatchEvent(new p.w.MessageEvent("message", { data, source: source as never }));
    const inspector = () => p.$("#pv-inspector").textContent ?? "";
    post({ type: "praxis:pick", part: "legend" });
    expect(inspector()).toMatch(/Switch to Inspect/); // Preview: ignored
    p.mode("inspect");
    post({ type: "praxis:pick", part: "legend" });
    expect(inspector()).toMatch(/Switch to Inspect/); // the frame does not have the focus: ignored
    frame.focus();
    // (a pick also needs the page's user activation, which jsdom does not model: Chrome checks it, see the runtime browser acceptance)
    post({ type: "praxis:pick", part: "legend" }, p.w);
    expect(inspector()).toMatch(/Switch to Inspect/); // not from the frame: ignored
    post({ type: "praxis:pick", part: "legend" });
    expect(inspector()).toContain("Легенда доски");
    expect(inspector()).toContain("REQ-JRN-003-AC-01");
    expect(p.$('[data-el="journal#board"]').classList.contains("sel")).toBe(true);
    post({ type: "praxis:pick", part: "nope" });
    expect(inspector()).toContain("Доска задач по полям"); // an undeclared part selects the element as a whole
    // a burst: four picks a second at most, the rest is dropped (the bucket started with four and two are used)
    post({ type: "praxis:pick", part: "legend" });
    post({ type: "praxis:pick", part: "nope" });
    post({ type: "praxis:pick", part: "legend" });
    expect(inspector()).toContain("Доска задач по полям");
    expect(inspector()).not.toContain("Легенда доски");
    await new Promise((r) => setTimeout(r, 300));
    expect(inspector()).toContain("Praxis does not check its behaviour or look");
    p.mode("review");
    frame.focus();
    post({ type: "praxis:pick", part: "legend" });
    expect(p.$('textarea[data-fb="journal#board@legend"]')).not.toBeNull();
    // nothing else a frame sends does anything: it cannot accept, save or comment for the person
    post({ type: "praxis:accept" });
    post({ type: "praxis:save", comment: "spoof" });
    expect(p.$<HTMLInputElement>("#accept-proto").checked).toBe(false);
    expect(p.decisions().prototype).toEqual({ feedback: [], resolve: [], accept: false });
  });

  it("shows its parts in Coverage and says in the page what it is", () => {
    const p = open(withCustom());
    const cov = p.$("details.pv-cov").textContent ?? "";
    expect(cov).toContain("Легенда доски");
    expect(cov).toContain("Колонка поля");
    expect(p.$("details.pv-about").textContent).toContain("Custom part «Доска задач по полям» on Журнал агронома: HTML, CSS and script written for this prototype, run in a sandboxed frame");
    expect(p.$("details.pv-about").textContent).toContain("no structured element shows columns of cards");
  });

  it("refuses a custom part without a reason, with a row card, with a scenario looking inside it, or with unknown links", () => {
    expect(() => withCustom((e) => delete e.custom)).toThrow(/needs custom settings/);
    expect(() => withCustom((e) => delete e.custom.reason)).toThrow();
    expect(() => withCustom((e) => (e.rowOpens = "card"))).toThrow(/cannot open a drawer or modal/);
    expect(() => withCustom((e) => (e.custom.parts[0].acIds = ["REQ-JRN-009-AC-01"]))).toThrow(/part legend links unknown acceptance criterion/);
    expect(() => withCustom((e) => (e.custom.html = "x".repeat(60_001)))).toThrow();
    expect(() => withCustom((e) => (e.custom.collections = ["ghosts"]))).toThrow(/custom collection ghosts does not exist/);
    expect(() =>
      withProto(chat((p) => {
        p.screens[0].elements.push(JSON.parse(JSON.stringify(CUSTOM)));
        p.scenarios.push({ id: "board-rows", title: "x", expect: { rows: [{ element: "board", count: 1 }] } });
      })),
    ).toThrow(/cannot look inside its sandboxed frame/);
    expect(() => withCustom((e) => (e.custom.script = 'var t="sk-' + "a".repeat(30) + '"'))).toThrow(/looks like a real secret/);
  });

  it("a removed criterion disappears from the parts that linked it", () => {
    const state = withCustom();
    const next = apply(state, { action: "review-requirements", decisions: [{ requirementId: "REQ-JRN-003", removeAcceptance: ["REQ-JRN-003-AC-01"] }] });
    const board = next.prototype!.screens[0].elements.find((e) => e.id === "board")!;
    expect(board.custom!.parts[0].acIds).toEqual([]);
    expect(board.custom!.parts[1].acIds).toEqual(["REQ-JRN-001-AC-03"]);
  });
});

describe("existing prototypes are unchanged", () => {
  it("the orders prototype keeps the fingerprint its acceptance was recorded with before conversation and custom existed", () => {
    let s = apply(null, { action: "open", projectId: "orders", title: "Orders filter", request: "Filter orders by status", mode: "guided" });
    for (const [id, n] of Object.entries({ "REQ-ORD-001": 7, "REQ-ORD-002": 9, "REQ-ORD-003": 2, "REQ-ORD-004": 6, "REQ-ORD-005": 7 }))
      s = apply(s, { action: "add-requirement", id, statement: `Requirement ${id} statement`, acceptanceCriteria: Array.from({ length: n }, (_, i) => `Criterion ${i + 1} of ${id}`) });
    s = apply(apply(s, { action: "accept-requirements", via: "html-review" }), { action: "set-prototype", prototype: ORDERS.prototype, summary: "interactive" });
    // value computed with the build before this change (contracts 0.1.0-alpha.49, commit 7e2739b)
    expect(prototypeFingerprint(s.prototype)).toBe("5117815d0b85b5ac");
    const page = open(s);
    expect(page.$("iframe")).toBeNull();
    expect(page.$$("#proto-screen tr[data-row]").length).toBe(6);
  });
});
