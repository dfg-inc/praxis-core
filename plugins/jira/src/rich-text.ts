import type {
  PraxisRichTextDocument,
  RichTextBlock,
  RichTextInline,
} from "@praxis/contracts";

function inlinesToPlain(inlines: RichTextInline[]): string {
  return inlines
    .map((n) => {
      if (n.type === "text") return n.text;
      if (n.type === "code") return `\`${n.text}\``;
      if (n.type === "link") return `[${n.text}|${n.href}]`;
      return n.key;
    })
    .join("");
}

function inlinesToAdf(inlines: RichTextInline[]): unknown[] {
  return inlines.map((n) => {
    if (n.type === "text") return { type: "text", text: n.text };
    if (n.type === "code") {
      return { type: "text", text: n.text, marks: [{ type: "code" }] };
    }
    if (n.type === "link") {
      return {
        type: "text",
        text: n.text,
        marks: [{ type: "link", attrs: { href: n.href } }],
      };
    }
    return { type: "text", text: n.key };
  });
}

function blockToWiki(block: RichTextBlock): string {
  switch (block.type) {
    case "heading":
      return `h${block.level}. ${block.text}`;
    case "paragraph":
      return inlinesToPlain(block.inlines);
    case "bulletList":
      return block.items.map((i) => `* ${inlinesToPlain(i)}`).join("\n");
    case "orderedList":
      return block.items.map((i) => `# ${inlinesToPlain(i)}`).join("\n");
    case "codeBlock": {
      const lang = block.language ?? "";
      return `{code${lang ? `:${lang}` : ""}}\n${block.text}\n{code}`;
    }
    case "table": {
      const head = `||${block.headers.join("||")}||`;
      const rows = block.rows.map((r) => `|${r.join("|")}|`).join("\n");
      return `${head}\n${rows}`;
    }
    default:
      return "";
  }
}

function blockToAdf(block: RichTextBlock): unknown {
  switch (block.type) {
    case "heading":
      return {
        type: "heading",
        attrs: { level: block.level },
        content: [{ type: "text", text: block.text }],
      };
    case "paragraph":
      return { type: "paragraph", content: inlinesToAdf(block.inlines) };
    case "bulletList":
      return {
        type: "bulletList",
        content: block.items.map((i) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inlinesToAdf(i) }],
        })),
      };
    case "orderedList":
      return {
        type: "orderedList",
        content: block.items.map((i) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inlinesToAdf(i) }],
        })),
      };
    case "codeBlock":
      return {
        type: "codeBlock",
        attrs: block.language ? { language: block.language } : {},
        content: [{ type: "text", text: block.text }],
      };
    case "table":
      return {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: block.headers.map((h) => ({
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: h }],
                },
              ],
            })),
          },
          ...block.rows.map((row) => ({
            type: "tableRow",
            content: row.map((c) => ({
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: c }],
                },
              ],
            })),
          })),
        ],
      };
    default:
      return { type: "paragraph", content: [] };
  }
}

export function renderRichTextWiki(doc: PraxisRichTextDocument): string {
  return doc.blocks.map(blockToWiki).join("\n\n");
}

export function renderRichTextAdf(doc: PraxisRichTextDocument): unknown {
  return {
    type: "doc",
    version: 1,
    content: doc.blocks.map(blockToAdf),
  };
}

export function renderRichText(
  doc: PraxisRichTextDocument,
  flavor: "cloud" | "datacenter",
): unknown {
  return flavor === "cloud" ? renderRichTextAdf(doc) : renderRichTextWiki(doc);
}

export function textDocument(text: string): PraxisRichTextDocument {
  return {
    version: 1,
    blocks: [
      { type: "paragraph", inlines: [{ type: "text", text }] },
    ],
  };
}

export function headingParagraphs(
  sections: Array<{ heading: string; body: string }>,
): PraxisRichTextDocument {
  const blocks: RichTextBlock[] = [];
  for (const s of sections) {
    blocks.push({ type: "heading", level: 2, text: s.heading });
    for (const para of s.body.split("\n\n")) {
      blocks.push({
        type: "paragraph",
        inlines: [{ type: "text", text: para }],
      });
    }
  }
  return { version: 1, blocks };
}
