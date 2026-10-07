import { journalFormats } from "./journal_dates.ts";
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
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
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

    assert(
      result.dataHandles.length === 1,
      "scan should return only the compact summary handle",
    );
    assert(
      writes.length === 5,
      "expected two pages, two blocks, and one summary write",
    );
    assert(
      writes.filter((write) => write.specName === "page").length === 2,
      "expected two page resources",
    );
    assert(
      writes.filter((write) => write.specName === "block").length === 2,
      "expected two block resources",
    );
    const summary = writes.find((write) => write.specName === "summary")
      ?.data as Record<string, unknown>;
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
    assert(
      message.includes("No Markdown pages found"),
      "expected actionable empty-graph error",
    );
    assert(writes === 0, "failure must occur before resource writes");
  });
});

Deno.test("scheduled selects exact dates and earlier dates", async () => {
  await withTempGraph({
    "pages/Tasks.md":
      "- Past\n  scheduled:: 2020-01-02\n- Future\n  scheduled:: 2999-12-31\n",
  }, async (graphPath) => {
    const writes: Array<{ specName: string; data: object }> = [];
    await model.methods.scheduled.execute(
      { date: "2020-01-02", before: false },
      {
        globalArgs: { graphPath },
        logger: { info: () => undefined },
        writeResource: (specName, name, data) => {
          writes.push({ specName, data });
          return Promise.resolve({ name });
        },
      },
    );
    assert(
      writes.filter((write) => write.specName === "scheduled").length === 1,
      "exact date should emit one scheduled result",
    );
    const result = writes.find((write) => write.specName === "scheduled")
      ?.data as Record<string, unknown>;
    assert(result.matchCount === 1, "exact date should match one block");
  });
});

Deno.test("journal links reports and rewrites historical titles", async () => {
  await withTempGraph({
    "logseq/config.edn": "{:meta/version 1}\n",
    "pages/Notes.md": "- Link [[Jan 1st, 1970]] and [[Other]]\n",
  }, async (graphPath) => {
    const command = new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: graphPath,
    });
    await command.output();
    for (
      const [name, value] of [["user.email", "test@example.com"], [
        "user.name",
        "Test",
      ]]
    ) {
      await new Deno.Command("git", {
        args: ["config", name, value],
        cwd: graphPath,
      }).output();
    }
    await new Deno.Command("git", { args: ["add", "."], cwd: graphPath })
      .output();
    await new Deno.Command("git", {
      args: ["commit", "-qm", "initial"],
      cwd: graphPath,
    }).output();
    await Deno.writeTextFile(
      `${graphPath}/logseq/config.edn`,
      ':journal/page-title-format "EEE, dd.MM.yyyy"\n',
    );
    await new Deno.Command("git", { args: ["add", "."], cwd: graphPath })
      .output();
    await new Deno.Command("git", {
      args: ["commit", "-qm", "new format"],
      cwd: graphPath,
    }).output();

    const formats = await journalFormats(graphPath);
    assert(
      formats[0].format === "EEE, dd.MM.yyyy",
      "configured format should be current",
    );
    assert(
      formats.some((format) =>
        format.format === "MMM do, yyyy" && !format.isCurrent
      ),
      "an unconfigured historical revision should contribute Logseq's default format",
    );

    const writes: Array<{ specName: string; data: Record<string, unknown> }> =
      [];
    const context = {
      globalArgs: { graphPath },
      logger: { info: () => undefined },
      writeResource: (specName: string, name: string, data: object) => {
        writes.push({ specName, data: data as Record<string, unknown> });
        return Promise.resolve({ name });
      },
    };
    await model.methods.rewriteJournalLinks.execute({ dryRun: true }, context);
    const dryRun = writes.find((write) => write.specName === "journalLinks")
      ?.data;
    assert(dryRun?.matchCount === 1, "dry run should find the old link");
    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Notes.md`)).includes(
        "Jan 1st, 1970",
      ),
      "dry run must not write",
    );

    writes.length = 0;
    await model.methods.rewriteJournalLinks.execute({ dryRun: false }, context);
    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Notes.md`)).includes(
        "[[Thu, 01.01.1970]]",
      ),
      "rewrite should use the current format",
    );
  });
});

Deno.test("journal formats use Logseq's default when no config file exists", async () => {
  await withTempGraph({ "pages/Notes.md": "- Note\n" }, async (graphPath) => {
    await new Deno.Command("git", { args: ["init", "-q"], cwd: graphPath })
      .output();
    for (
      const [name, value] of [["user.email", "test@example.com"], [
        "user.name",
        "Test",
      ]]
    ) {
      await new Deno.Command("git", {
        args: ["config", name, value],
        cwd: graphPath,
      }).output();
    }
    await new Deno.Command("git", { args: ["add", "."], cwd: graphPath })
      .output();
    await new Deno.Command("git", {
      args: ["commit", "-qm", "initial"],
      cwd: graphPath,
    }).output();
    const formats = await journalFormats(graphPath);
    assert(
      formats.length === 1,
      "an unconfigured graph should have one effective format",
    );
    assert(
      formats[0].format === "MMM do, yyyy",
      "the effective format should be Logseq's default",
    );
    assert(formats[0].isCurrent, "the default should be current");
  });
});

Deno.test("convertNamespaceToPropertyBasedItems previews and applies page, reference, and property changes", async () => {
  await withTempGraph({
    "pages/inbox___MisspelledTitle.md": "Imported content.\n",
    "pages/Notes.md": "- [[inbox/MisspelledTitle]] #[[inbox/Second_Title]]\n",
  }, async (graphPath) => {
    const writes: Array<{ specName: string; data: Record<string, unknown> }> =
      [];
    const context = {
      globalArgs: { graphPath },
      logger: { info: () => undefined },
      writeResource: (specName: string, name: string, data: object) => {
        writes.push({ specName, data: data as Record<string, unknown> });
        return Promise.resolve({ name });
      },
    };
    const titleMappings = { "inbox/MisspelledTitle": "Correct Title" };

    await model.methods.convertNamespaceToPropertyBasedItems.execute(
      {
        dryRun: true,
        namespace: "inbox",
        propertyKey: "classification",
        propertyValue: "[[Imported Item]]",
        titleMappings,
      },
      context,
    );
    const preview = writes.find((write) =>
      write.specName === "namespaceConversion"
    )?.data;
    assert(
      preview?.matchCount === 2,
      "preview should include both namespaced references",
    );
    const matches = preview?.matches as Array<{
      source: string;
      target: string;
    }>;
    assert(
      matches.some((match) =>
        match.source === "inbox/Second_Title" && match.target === "Second Title"
      ),
      "underscores should normalize to a title-cased item title",
    );
    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Notes.md`)).includes(
        "[[inbox/MisspelledTitle]]",
      ),
      "dry run must not rewrite references",
    );
    assert(
      await exists(`${graphPath}/pages/inbox___MisspelledTitle.md`),
      "dry run must not rename pages",
    );

    writes.length = 0;
    await model.methods.convertNamespaceToPropertyBasedItems.execute(
      {
        dryRun: false,
        namespace: "inbox",
        propertyKey: "classification",
        propertyValue: "[[Imported Item]]",
        titleMappings,
      },
      context,
    );
    const rewritten = await Deno.readTextFile(`${graphPath}/pages/Notes.md`);
    assert(
      rewritten.includes("[[Correct Title]] #[[Second Title]]"),
      "apply should rewrite page links and bracketed tags",
    );
    assert(
      !(await exists(`${graphPath}/pages/inbox___MisspelledTitle.md`)),
      "apply should remove the namespaced page file",
    );
    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Correct Title.md`))
        .startsWith(
          "classification:: [[Imported Item]]\n",
        ),
      "renamed page should receive the configured property",
    );
  });
});

Deno.test("convertNamespaceToPropertyBasedItems accepts a namespace and property configuration", async () => {
  await withTempGraph({
    "pages/contacts___Ada_Lovelace.md": "Known mathematician.\n",
    "pages/Notes.md": "- [[contacts/Ada_Lovelace]]\n",
  }, async (graphPath) => {
    await model.methods.convertNamespaceToPropertyBasedItems.execute({
      dryRun: false,
      namespace: "contacts",
      propertyKey: "kind",
      propertyValue: "[[Contact]]",
      titleMappings: {},
    }, {
      globalArgs: { graphPath },
      logger: { info: () => undefined },
      writeResource: (_specName, name) => Promise.resolve({ name }),
    });

    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Notes.md`)).includes(
        "[[Ada Lovelace]]",
      ),
      "configured namespace should be rewritten",
    );
    assert(
      (await Deno.readTextFile(`${graphPath}/pages/Ada Lovelace.md`))
        .startsWith(
          "kind:: [[Contact]]\n",
        ),
      "configured property should be written to the normalized page",
    );
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
