import { model } from "./logseq_graph.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function withTempGraph(
  files: Record<string, string>,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempDir({ prefix: "logseq-graph-test-" });
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = `${path}/${relativePath}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(target, content);
    }
    await run(path);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

Deno.test("scan emits page, block, and summary resources", async () => {
  await withTempGraph({
    "pages/Project.md": "status:: active\n- Work on [[Roadmap]] #next",
    "journals/2026_08_28.md": "- Journal entry",
  }, async (graphPath) => {
    const writes: Array<{ specName: string; name: string; data: object }> = [];
    const result = await model.methods.scan.execute({}, {
      globalArgs: { graphPath },
      logger: { info: () => undefined },
      writeResource: (specName, name, data) => {
        writes.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    });

    assert(result.dataHandles.length === 1, "scan should return only the compact summary handle");
    assert(writes.length === 5, "expected two pages, two blocks, and one summary write");
    assert(writes.filter((write) => write.specName === "page").length === 2, "expected two page resources");
    assert(writes.filter((write) => write.specName === "block").length === 2, "expected two block resources");
    const summary = writes.find((write) => write.specName === "summary")?.data as Record<string, unknown>;
    assert(summary.pageCount === 2, "summary should count pages");
    assert(summary.blockCount === 2, "summary should count blocks");
  });
});

Deno.test("scan fails before writing when no Markdown pages exist", async () => {
  await withTempGraph({}, async (graphPath) => {
    let writes = 0;
    let message = "";
    try {
      await model.methods.scan.execute({}, {
        globalArgs: { graphPath },
        logger: { info: () => undefined },
        writeResource: (_specName, name) => {
          writes++;
          return Promise.resolve({ name });
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("No Markdown pages found"), "expected actionable empty-graph error");
    assert(writes === 0, "failure must occur before resource writes");
  });
});

Deno.test("scheduled selects exact dates and earlier dates", async () => {
  await withTempGraph({
    "pages/Tasks.md": "- Past\n  scheduled:: 2020-01-02\n- Future\n  scheduled:: 2999-12-31\n",
  }, async (graphPath) => {
    const writes: Array<{ specName: string; data: object }> = [];
    await model.methods.scheduled.execute({ date: "2020-01-02", before: false }, {
      globalArgs: { graphPath },
      logger: { info: () => undefined },
      writeResource: (specName, name, data) => {
        writes.push({ specName, data });
        return Promise.resolve({ name });
      },
    });
    assert(writes.filter((write) => write.specName === "scheduled").length === 1, "exact date should emit one scheduled result");
    const result = writes.find((write) => write.specName === "scheduled")?.data as Record<string, unknown>;
    assert(result.matchCount === 1, "exact date should match one block");
  });
});
