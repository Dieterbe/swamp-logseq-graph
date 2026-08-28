/**
 * Reads a local Logseq Markdown graph into queryable resources.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parseLogseqFile } from "./logseq_parser.ts";

const VERSION = "2026.08.28.3";
const GlobalArgsSchema = z.object({
  graphPath: z.string().min(1).describe("Absolute path to the Logseq graph"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CommonReferencesSchema = z.object({
  scannedAt: z.iso.datetime(),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  blockRefs: z.array(z.string()),
});
const PageSchema = z.object({
  path: z.string(),
  title: z.string(),
  namespace: z.array(z.string()),
  properties: z.record(z.string(), z.string()),
  blockCount: z.number().int().nonnegative(),
}).extend(CommonReferencesSchema.shape);
const BlockSchema = z.object({
  id: z.string(),
  page: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  content: z.string(),
  properties: z.record(z.string(), z.string()),
}).extend(CommonReferencesSchema.shape);
const SummarySchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  pageCount: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
});

type DataHandle = { name: string };
type Context = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, values?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: object,
  ) => Promise<DataHandle>;
};

async function markdownFiles(graphPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const directory of ["pages", "journals"]) {
    const root = `${graphPath.replace(/\/$/, "")}/${directory}`;
    try {
      for await (const entry of Deno.readDir(root)) {
        if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
          files.push(`${directory}/${entry.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function resourceName(prefix: string, value: string): Promise<string> {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hash = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-${safe.slice(0, 60) || "item"}-${hash}`;
}

/** Logseq graph reader model. */
export const model = {
  type: "@dieter/logseq-graph",
  version: VERSION,
  globalArguments: GlobalArgsSchema,
  resources: {
    page: {
      description: "A Logseq page and its outgoing references",
      schema: PageSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    block: {
      description: "A Logseq block and its outgoing references",
      schema: BlockSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    summary: {
      description: "Counts and timestamp for a completed graph scan",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description:
        "Read pages and journals and emit typed page, block, and summary resources.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info("Scanning Logseq graph at {graphPath}", {
          graphPath,
        });
        const files = await markdownFiles(graphPath);
        if (files.length === 0) {
          throw new Error(
            `No Markdown pages found under ${graphPath}/pages or ${graphPath}/journals`,
          );
        }

        const parsed = [];
        for (const path of files) {
          parsed.push(
            parseLogseqFile(
              path,
              await Deno.readTextFile(`${graphPath}/${path}`),
            ),
          );
        }
        const scannedAt = new Date().toISOString();
        const handles: DataHandle[] = [];
        for (const item of parsed) {
          handles.push(
            await context.writeResource(
              "page",
              await resourceName("page", item.page.path),
              { ...item.page, scannedAt },
            ),
          );
          for (const block of item.blocks) {
            handles.push(
              await context.writeResource(
                "block",
                await resourceName("block", block.id),
                { ...block, scannedAt },
              ),
            );
          }
        }
        const summaryHandle = await context.writeResource(
          "summary",
          "summary-current",
          {
            graphPath,
            scannedAt,
            pageCount: parsed.length,
            blockCount: parsed.reduce(
              (count, item) => count + item.blocks.length,
              0,
            ),
          },
        );
        context.logger.info(
          "Scanned {pageCount} pages and {blockCount} blocks",
          {
            pageCount: parsed.length,
            blockCount: parsed.reduce(
              (count, item) => count + item.blocks.length,
              0,
            ),
          },
        );
        // Writes are persisted individually; return only the compact summary
        // to keep large-graph reports bounded.
        return { dataHandles: [summaryHandle] };
      },
    },
  },
};
