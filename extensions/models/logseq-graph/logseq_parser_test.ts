import { parseLogseqFile } from "./logseq_parser.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

Deno.test("parses Logseq page metadata, blocks, and references", () => {
  const result = parseLogseqFile("pages/Work___Project.md", `title:: Work/Project
status:: active
- First block [[People/Ada]] #important
  id:: 12345678-abcd-1234-abcd-123456789abc
  - Nested ((abcdef12-1234-1234-1234-abcdef123456))
`);
  assertEquals(result.page.title, "Work/Project");
  assertEquals(result.page.namespace, ["Work"]);
  assertEquals(result.page.properties, { title: "Work/Project", status: "active" });
  assertEquals(result.page.links, ["important", "People/Ada"]);
  assertEquals(result.blocks.length, 2);
  assertEquals(result.blocks[0].properties.id, "12345678-abcd-1234-abcd-123456789abc");
  assertEquals(result.blocks[1].depth, 1);
});

Deno.test("derives page title from Logseq namespace filename", () => {
  const result = parseLogseqFile("pages/Area___Topic.md", "- note");
  assertEquals(result.page.title, "Area/Topic");
  assertEquals(result.blocks[0].id, "pages/Area___Topic.md:1");
});

Deno.test("marks past scheduled and deadline dates as overdue", () => {
  const result = parseLogseqFile("pages/Tasks.md", `- Scheduled task\n  scheduled:: 2020-01-02\n- Future task\n  DEADLINE: <2999-12-31>\n`);
  assertEquals(result.blocks[0].scheduledDate, "2020-01-02");
  assertEquals(result.blocks[0].overdue, true);
  assertEquals(result.blocks[1].deadlineDate, "2999-12-31");
  assertEquals(result.blocks[1].overdue, false);
  assertEquals(result.page.overdueCount, 1);
});
