/**
 * Reads a local Logseq Markdown graph into queryable resources.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { findJournalLinks, journalFormats } from "./journal_dates.ts";
import { parseLogseqFile } from "./logseq_parser.ts";

const GlobalArgsSchema = z.object({
  graphPath: z.string().min(1).describe("Absolute path to the Logseq graph"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
const ScheduledArgsSchema = z.object({
  date: z.iso.date().optional().describe("Exact scheduled date or upper bound"),
  before: z.boolean().default(false).describe(
    "Include dates before the selected date",
  ),
});
type ScheduledArgs = z.infer<typeof ScheduledArgsSchema>;
const RewriteJournalLinksArgsSchema = z.object({
  dryRun: z.boolean().default(true).describe(
    "Report proposed changes without writing files; defaults to true",
  ),
});
type RewriteJournalLinksArgs = z.infer<typeof RewriteJournalLinksArgsSchema>;
const ConvertNamespaceToPropertyBasedItemsArgsSchema = z.object({
  dryRun: z.boolean().default(true).describe(
    "Report proposed changes without writing files; defaults to true",
  ),
  namespace: z.string().min(1).describe(
    "Namespace to remove from page references and page titles",
  ),
  propertyKey: z.string().regex(/^[\p{L}\p{N}_-]+$/u)
    .describe("Page property key to add or update"),
  propertyValue: z.string().min(1).describe(
    "Page property value to add or update",
  ),
  mergeExistingPages: z.boolean().default(false).describe(
    "Merge a namespaced page into an existing page with the target title",
  ),
  titleMappings: z.record(z.string(), z.string()).default({}).describe(
    "Explicit replacements keyed by the unqualified name or <namespace>/<name>; use this for spell corrections that cannot be inferred from underscores or camel case",
  ),
});
type ConvertNamespaceToPropertyBasedItemsArgs = z.infer<
  typeof ConvertNamespaceToPropertyBasedItemsArgsSchema
>;
const UpdatePagePropertyAndTagArgsSchema = z.object({
  propertyKey: z.string().regex(/^[\p{L}\p{N}_-]+$/u).describe(
    "Page property key to match and update",
  ),
  fromValue: z.string().min(1).describe("Current property value to match"),
  toValue: z.string().min(1).describe("Replacement property value"),
  tag: z.string().regex(/^#?[\p{L}\p{N}_/-]+$/u).describe(
    "Tag to add to the tags page property, with or without a leading #",
  ),
  tagsProperty: z.string().regex(/^[\p{L}\p{N}_-]+$/u).default("tags")
    .describe("Page property containing tags"),
});
type UpdatePagePropertyAndTagArgs = z.infer<
  typeof UpdatePagePropertyAndTagArgsSchema
>;

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
  overdueCount: z.number().int().nonnegative(),
}).extend(CommonReferencesSchema.shape);
const BlockSchema = z.object({
  id: z.string(),
  page: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  content: z.string(),
  properties: z.record(z.string(), z.string()),
  scheduledDate: z.string().nullable(),
  deadlineDate: z.string().nullable(),
  overdue: z.boolean(),
}).extend(CommonReferencesSchema.shape);
const SummarySchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  pageCount: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
});
const ScheduledSummarySchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  date: z.string().nullable(),
  before: z.boolean(),
  matchCount: z.number().int().nonnegative(),
});
const ScheduledSchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  date: z.string().nullable(),
  before: z.boolean(),
  matchCount: z.number().int().nonnegative(),
  items: z.array(BlockSchema),
});
const JournalFormatsSchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  currentFormat: z.string(),
  formats: z.array(z.object({ format: z.string(), isCurrent: z.boolean() })),
});
const JournalLinkSchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  matchCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  matches: z.array(z.object({
    path: z.string(),
    line: z.number().int().positive(),
    content: z.string(),
    link: z.string(),
    sourceFormat: z.string(),
    replacement: z.string(),
  })),
});
const NamespaceConversionSchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  matchCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  createdPageCount: z.number().int().nonnegative(),
  renamedPageCount: z.number().int().nonnegative(),
  mergedPageCount: z.number().int().nonnegative(),
  matches: z.array(z.object({
    source: z.string(),
    target: z.string(),
  })),
});
const PagePropertyUpdateSchema = z.object({
  graphPath: z.string(),
  scannedAt: z.iso.datetime(),
  matchCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  propertyKey: z.string(),
  fromValue: z.string(),
  toValue: z.string(),
  tag: z.string(),
  matches: z.array(z.object({ path: z.string(), title: z.string() })),
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

async function graphMarkdown(
  graphPath: string,
): Promise<Array<{ path: string; source: string }>> {
  const files: Array<{ path: string; source: string }> = [];
  for (const path of await markdownFiles(graphPath)) {
    files.push({
      path,
      source: await Deno.readTextFile(`${graphPath}/${path}`),
    });
  }
  return files;
}

function humanizeItemTitle(name: string): string {
  return name.replace(/[_-]+/g, " ")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(
      /(^|\s)(\p{Ll})/gu,
      (_match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase()}`,
    )
    .trim();
}

function itemTitle(
  name: string,
  titleMappings: Record<string, string>,
  namespace: string,
): string {
  const title = titleMappings[`${namespace}/${name}`] ??
    titleMappings[name] ?? humanizeItemTitle(name);
  if (!title || /[\\/\0]/.test(title)) {
    throw new Error(`Invalid page title for ${namespace}/${name}`);
  }
  return title;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withProperty(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  const firstBlock = lines.findIndex((line) => /^\s*[-*+]\s+/.test(line));
  const preambleEnd = firstBlock === -1 ? lines.length : firstBlock;
  const property = new RegExp(`^\\s*${escapeRegExp(key)}::\\s*`, "i");
  for (let index = 0; index < preambleEnd; index++) {
    if (property.test(lines[index])) {
      lines[index] = `${key}:: ${value}`;
      return lines.join("\n");
    }
  }
  return [`${key}:: ${value}`, ...lines].join("\n");
}

function mergePageSources(
  targetSource: string,
  incomingSource: string,
  targetTitle: string,
  sourceTitle: string,
  propertyKey: string,
  propertyValue: string,
): string {
  const targetPage =
    parseLogseqFile(`pages/${targetTitle}.md`, targetSource).page;
  const incomingPage = parseLogseqFile(
    `pages/${sourceTitle.replace(/\//g, "___")}.md`,
    incomingSource,
  ).page;
  const targetProperties = new Map(
    Object.entries(targetPage.properties).map(([key, value]) => [
      key.toLocaleLowerCase(),
      { key, value },
    ]),
  );
  for (const [key, value] of Object.entries(incomingPage.properties)) {
    const normalizedKey = key.toLocaleLowerCase();
    if (normalizedKey === propertyKey.toLocaleLowerCase()) continue;
    const target = targetProperties.get(normalizedKey);
    if (target && target.value !== value) {
      throw new Error(
        `Cannot merge ${sourceTitle} into ${targetTitle}: property ${key} has conflicting values (${target.value} and ${value})`,
      );
    }
  }

  const targetLines = withProperty(targetSource, propertyKey, propertyValue)
    .split(/\r?\n/);
  const targetFirstBlock = targetLines.findIndex((line) =>
    /^\s*[-*+]\s+/.test(line)
  );
  const targetPreambleEnd = targetFirstBlock === -1
    ? targetLines.length
    : targetFirstBlock;
  const targetKeys = new Set(
    Object.keys(targetPage.properties).map((key) => key.toLocaleLowerCase()),
  );
  const incomingLines = incomingSource.split(/\r?\n/);
  const incomingFirstBlock = incomingLines.findIndex((line) =>
    /^\s*[-*+]\s+/.test(line)
  );
  const incomingPreambleEnd = incomingFirstBlock === -1
    ? incomingLines.length
    : incomingFirstBlock;
  const propertyLine = /^\s*([\p{L}\p{N}_-]+)::\s*(.*)$/u;
  const addedProperties: string[] = [];
  for (const line of incomingLines.slice(0, incomingPreambleEnd)) {
    const match = line.match(propertyLine);
    if (!match) continue;
    const [, key] = match;
    const normalizedKey = key.toLocaleLowerCase();
    if (
      normalizedKey === propertyKey.toLocaleLowerCase() ||
      targetKeys.has(normalizedKey)
    ) continue;
    addedProperties.push(line);
    targetKeys.add(normalizedKey);
  }
  if (addedProperties.length > 0) {
    targetLines.splice(targetPreambleEnd, 0, ...addedProperties);
  }

  const incomingPreambleContent = incomingLines.slice(0, incomingPreambleEnd)
    .filter((line) => !propertyLine.test(line)).join("\n").trim();
  const incomingBody = [
    incomingPreambleContent,
    incomingLines.slice(incomingPreambleEnd).join("\n").trim(),
  ].filter(Boolean).join("\n\n");
  const marker = `- Merged content from ${sourceTitle}`;
  if (!incomingBody || targetSource.includes(marker)) {
    return targetLines.join("\n");
  }
  return `${targetLines.join("\n").trimEnd()}\n${marker}\n${incomingBody}\n`;
}

function normalizedPropertyValue(value: string): string {
  return value.trim().replace(/^\[\[(.*)\]\]$/u, "$1").trim()
    .toLocaleLowerCase();
}

function updatePagePropertyAndTag(
  source: string,
  propertyKey: string,
  fromValue: string,
  toValue: string,
  tagsProperty: string,
  tag: string,
): string {
  const lines = source.split(/\r?\n/);
  const firstBlock = lines.findIndex((line) => /^\s*[-*+]\s+/.test(line));
  const preambleEnd = firstBlock === -1 ? lines.length : firstBlock;
  const property = new RegExp(
    `^\\s*(${escapeRegExp(propertyKey)})::\\s*(.*)$`,
    "i",
  );
  const tags = new RegExp(
    `^\\s*(${escapeRegExp(tagsProperty)})::\\s*(.*)$`,
    "i",
  );
  let matched = false;
  let tagsFound = false;
  for (let index = 0; index < preambleEnd; index++) {
    const propertyMatch = lines[index].match(property);
    if (
      propertyMatch &&
      normalizedPropertyValue(propertyMatch[2]) ===
        normalizedPropertyValue(fromValue)
    ) {
      lines[index] = `${propertyKey}:: ${toValue}`;
      matched = true;
      continue;
    }
    const tagsMatch = lines[index].match(tags);
    if (tagsMatch) {
      tagsFound = true;
      const existingTags = tagsMatch[2];
      const alreadyPresent = new RegExp(
        `(?:^|[\\s,])#?${escapeRegExp(tag.replace(/^#/, ""))}(?=$|[\\s,])`,
        "i",
      ).test(existingTags);
      if (!alreadyPresent) {
        lines[index] = `${tagsProperty}:: ${existingTags.trim()}${
          existingTags.trim() ? " " : ""
        }${tag}`;
      }
    }
  }
  if (!matched) return source;
  if (!tagsFound) lines.splice(preambleEnd, 0, `${tagsProperty}:: ${tag}`);
  return lines.join("\n");
}

function namespacedReferences(source: string, namespace: string): string[] {
  const expression = new RegExp(
    `\\[\\[${escapeRegExp(namespace)}\\/([^\\]\\/]+)\\]\\]`,
    "gi",
  );
  return [...source.matchAll(expression)].map((match) => match[1].trim())
    .filter(Boolean);
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
  version: "2026.11.05.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.05.3",
      description:
        "Add property-based page migration and merge support without changing global arguments.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: [{
    "graph-pages-directory": {
      description:
        "Ensure the configured graph has a readable pages directory before a page migration",
      labels: ["dependency"],
      appliesTo: [
        "convertNamespaceToPropertyBasedItems",
        "updatePagePropertyAndTag",
      ],
      execute: async (context: { globalArgs: GlobalArgs }) => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        try {
          const info = await Deno.stat(`${graphPath}/pages`);
          if (!info.isDirectory) {
            return {
              pass: false,
              errors: [`${graphPath}/pages is not a directory`],
            };
          }
          for await (const _entry of Deno.readDir(`${graphPath}/pages`)) break;
          return { pass: true };
        } catch (error) {
          return {
            pass: false,
            errors: [
              `Cannot read ${graphPath}/pages: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ],
          };
        }
      },
    },
  }],
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
    scheduledSummary: {
      description: "Counts for a scheduled-block query",
      schema: ScheduledSummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    scheduled: {
      description: "Blocks matching a scheduled-date query",
      schema: ScheduledSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    journalFormats: {
      description: "Current and historical Logseq journal page-title formats",
      schema: JournalFormatsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    journalLinks: {
      description:
        "Historical journal links found or rewritten by a migration run",
      schema: JournalLinkSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    namespaceConversion: {
      description:
        "Planned or applied conversion of namespaced pages and references into property-based items",
      schema: NamespaceConversionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    pagePropertyUpdate: {
      description:
        "Pages selected by an existing property value, with that value updated and a tag added",
      schema: PagePropertyUpdateSchema,
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
    scheduled: {
      description:
        "Find blocks with scheduled dates, optionally selecting one date or dates before it.",
      arguments: ScheduledArgsSchema,
      execute: async (
        args: ScheduledArgs,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info("Finding scheduled blocks in {graphPath}", {
          graphPath,
        });
        const files = await markdownFiles(graphPath);
        const parsed = [];
        for (const path of files) {
          parsed.push(
            parseLogseqFile(
              path,
              await Deno.readTextFile(`${graphPath}/${path}`),
            ),
          );
        }
        if (args.before && !args.date) {
          throw new Error(
            "scheduled --before requires --input date=YYYY-MM-DD",
          );
        }
        const matches = parsed.flatMap((item) => item.blocks).filter(
          (block) => {
            if (!block.scheduledDate) return false;
            if (!args.date) return true;
            return args.before
              ? block.scheduledDate < args.date
              : block.scheduledDate === args.date;
          },
        );
        const scannedAt = new Date().toISOString();
        const scheduledHandle = await context.writeResource(
          "scheduled",
          `scheduled-${args.date ?? "all"}-${args.before ? "before" : "exact"}`,
          {
            graphPath,
            scannedAt,
            date: args.date ?? null,
            before: args.before,
            matchCount: matches.length,
            items: matches.map((block) => ({ ...block, scannedAt })),
          },
        );
        context.logger.info("Found {matchCount} scheduled blocks", {
          matchCount: matches.length,
        });
        return { dataHandles: [scheduledHandle] };
      },
    },
    journalFormats: {
      description:
        "List the current journal page-title format and distinct formats recorded in Git history.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info("Reading journal formats from {graphPath}", {
          graphPath,
        });
        const formats = await journalFormats(graphPath);
        const handle = await context.writeResource(
          "journalFormats",
          "journal-formats-current",
          {
            graphPath,
            scannedAt: new Date().toISOString(),
            currentFormat: formats[0].format,
            formats,
          },
        );
        context.logger.info("Found {formatCount} journal formats", {
          formatCount: formats.length,
        });
        return { dataHandles: [handle] };
      },
    },
    journalLinks: {
      description:
        "Print and store Markdown lines containing journal links in a historical title format.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info("Finding historical journal links in {graphPath}", {
          graphPath,
        });
        const formats = await journalFormats(graphPath);
        const matches = findJournalLinks(
          await graphMarkdown(graphPath),
          formats,
        );
        for (const match of matches) {
          context.logger.info("{path}:{line}: {content}", {
            path: match.path,
            line: match.line,
            content: match.content,
          });
        }
        const handle = await context.writeResource(
          "journalLinks",
          "journal-links-current",
          {
            graphPath,
            scannedAt: new Date().toISOString(),
            dryRun: true,
            matchCount: matches.length,
            changedFileCount: 0,
            matches,
          },
        );
        context.logger.info("Found {matchCount} historical journal links", {
          matchCount: matches.length,
        });
        return { dataHandles: [handle] };
      },
    },
    rewriteJournalLinks: {
      description:
        "Rewrite historical journal links using the current title format; dry-run is the default.",
      arguments: RewriteJournalLinksArgsSchema,
      execute: async (
        args: RewriteJournalLinksArgs,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info(
          "Rewriting historical journal links in {graphPath}",
          { graphPath },
        );
        const files = await graphMarkdown(graphPath);
        const matches = findJournalLinks(
          files,
          await journalFormats(graphPath),
        );
        for (const match of matches) {
          context.logger.info("{path}:{line}: {content}", {
            path: match.path,
            line: match.line,
            content: match.content,
          });
        }
        const changedPaths = new Set<string>();
        if (!args.dryRun) {
          for (const file of files) {
            const replacements = matches.filter((match) =>
              match.path === file.path
            );
            if (replacements.length === 0) continue;
            const replacementByLink = new Map(
              replacements.map((match) => [match.link, match.replacement]),
            );
            await Deno.writeTextFile(
              `${graphPath}/${file.path}`,
              file.source.replace(
                /\[\[[^\]]+\]\]/g,
                (link) => replacementByLink.get(link) ?? link,
              ),
            );
            changedPaths.add(file.path);
          }
        }
        const handle = await context.writeResource(
          "journalLinks",
          `journal-links-${args.dryRun ? "dry-run" : "rewritten"}`,
          {
            graphPath,
            scannedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            matchCount: matches.length,
            changedFileCount: changedPaths.size,
            matches,
          },
        );
        context.logger.info(
          "Journal link rewrite completed: {changedFileCount} files changed",
          { changedFileCount: changedPaths.size },
        );
        return { dataHandles: [handle] };
      },
    },
    convertNamespaceToPropertyBasedItems: {
      description:
        "Convert references in a configurable namespace into un-namespaced pages and add a configurable page property; dry-run is the default.",
      arguments: ConvertNamespaceToPropertyBasedItemsArgsSchema,
      execute: async (
        args: ConvertNamespaceToPropertyBasedItemsArgs,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info("Converting namespace {namespace} in {graphPath}", {
          namespace: args.namespace,
          graphPath,
        });
        const namespace = args.namespace.replace(/^\/+|\/+$/g, "");
        const propertyKey = args.propertyKey;
        const propertyValue = args.propertyValue;
        if (!namespace || namespace.split("/").some((part) => !part)) {
          throw new Error("namespace must not contain empty path segments");
        }
        const files = await graphMarkdown(graphPath);
        const itemTitles = new Map<string, string>();
        for (const file of files) {
          for (const name of namespacedReferences(file.source, namespace)) {
            itemTitles.set(
              name,
              itemTitle(name, args.titleMappings, namespace),
            );
          }
          if (file.path.startsWith("pages/")) {
            const page = parseLogseqFile(file.path, file.source).page;
            if (
              page.title.toLocaleLowerCase().startsWith(
                `${namespace}/`.toLocaleLowerCase(),
              )
            ) {
              const name = page.title.slice(namespace.length + 1);
              itemTitles.set(
                name,
                itemTitle(name, args.titleMappings, namespace),
              );
            }
          }
        }

        const matches = [...itemTitles.entries()].map(([name, target]) => ({
          source: `${namespace}/${name}`,
          target,
        })).sort((left, right) => left.source.localeCompare(right.source));
        const replacementBySource = new Map(
          matches.map((match) => [match.source, `[[${match.target}]]`]),
        );
        const sourcePages = new Map<string, typeof files[number]>();
        const existingTitles = new Map<string, typeof files[number]>();
        for (
          const file of files.filter((file) => file.path.startsWith("pages/"))
        ) {
          const title = parseLogseqFile(file.path, file.source).page.title;
          existingTitles.set(title.toLocaleLowerCase(), file);
          if (
            title.toLocaleLowerCase().startsWith(
              `${namespace}/`.toLocaleLowerCase(),
            )
          ) {
            const target = itemTitle(
              title.slice(namespace.length + 1),
              args.titleMappings,
              namespace,
            );
            const prior = sourcePages.get(target.toLocaleLowerCase());
            if (prior && prior.path !== file.path) {
              throw new Error(
                `Cannot normalize both ${prior.path} and ${file.path} to [[${target}]]`,
              );
            }
            sourcePages.set(target.toLocaleLowerCase(), file);
          }
        }
        for (const target of new Set(matches.map((match) => match.target))) {
          const source = sourcePages.get(target.toLocaleLowerCase());
          const existing = existingTitles.get(target.toLocaleLowerCase());
          if (
            source && existing && source.path !== existing.path &&
            !args.mergeExistingPages
          ) {
            throw new Error(
              `Cannot normalize ${source.path}: page [[${target}]] already exists at ${existing.path}`,
            );
          }
        }

        const rewrittenByPath = new Map(files.map((file) => [
          file.path,
          file.source.replace(
            new RegExp(
              `\\[\\[${escapeRegExp(namespace)}\\/([^\\]\\/]+)\\]\\]`,
              "gi",
            ),
            (link, name) =>
              replacementBySource.get(`${namespace}/${name.trim()}`) ?? link,
          ),
        ]));
        const mergePlans = new Map<string, {
          sourcePath: string;
          targetPath: string;
          content: string;
        }>();
        for (const target of new Set(matches.map((match) => match.target))) {
          const source = sourcePages.get(target.toLocaleLowerCase());
          const existing = existingTitles.get(target.toLocaleLowerCase());
          if (!source || !existing || source.path === existing.path) continue;
          const sourceTitle =
            parseLogseqFile(source.path, source.source).page.title;
          const content = mergePageSources(
            rewrittenByPath.get(existing.path) ?? existing.source,
            rewrittenByPath.get(source.path) ?? source.source,
            target,
            sourceTitle,
            propertyKey,
            propertyValue,
          );
          mergePlans.set(target.toLocaleLowerCase(), {
            sourcePath: source.path,
            targetPath: existing.path,
            content,
          });
        }

        const changedPaths = new Set<string>();
        let createdPageCount = 0;
        let renamedPageCount = 0;
        let mergedPageCount = 0;
        if (!args.dryRun) {
          for (const file of files) {
            if (
              [...mergePlans.values()].some((plan) =>
                plan.sourcePath === file.path || plan.targetPath === file.path
              )
            ) continue;
            const rewritten = rewrittenByPath.get(file.path) ?? file.source;
            if (rewritten !== file.source) {
              await Deno.writeTextFile(`${graphPath}/${file.path}`, rewritten);
              changedPaths.add(file.path);
            }
          }
          for (const plan of mergePlans.values()) {
            await Deno.writeTextFile(
              `${graphPath}/${plan.targetPath}`,
              plan.content,
            );
            await Deno.remove(`${graphPath}/${plan.sourcePath}`);
            changedPaths.add(plan.targetPath);
            changedPaths.add(plan.sourcePath);
            mergedPageCount++;
          }
          for (const target of new Set(matches.map((match) => match.target))) {
            if (mergePlans.has(target.toLocaleLowerCase())) continue;
            const source = sourcePages.get(target.toLocaleLowerCase());
            if (source) {
              const targetPath = `pages/${target}.md`;
              const typed = withProperty(
                await Deno.readTextFile(`${graphPath}/${source.path}`),
                propertyKey,
                propertyValue,
              );
              await Deno.writeTextFile(`${graphPath}/${source.path}`, typed);
              changedPaths.add(source.path);
              if (source.path !== targetPath) {
                await Deno.rename(
                  `${graphPath}/${source.path}`,
                  `${graphPath}/${targetPath}`,
                );
                changedPaths.delete(source.path);
                changedPaths.add(targetPath);
                renamedPageCount++;
              }
            } else {
              const existing = existingTitles.get(target.toLocaleLowerCase());
              if (existing) {
                const typed = withProperty(
                  await Deno.readTextFile(`${graphPath}/${existing.path}`),
                  propertyKey,
                  propertyValue,
                );
                await Deno.writeTextFile(
                  `${graphPath}/${existing.path}`,
                  typed,
                );
                changedPaths.add(existing.path);
                continue;
              }
              const targetPath = `pages/${target}.md`;
              await Deno.writeTextFile(
                `${graphPath}/${targetPath}`,
                `${propertyKey}:: ${propertyValue}\n`,
              );
              changedPaths.add(targetPath);
              createdPageCount++;
            }
          }
        }
        const handle = await context.writeResource(
          "namespaceConversion",
          `namespace-conversion-${args.dryRun ? "dry-run" : "rewritten"}`,
          {
            graphPath,
            scannedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            matchCount: matches.length,
            changedFileCount: changedPaths.size,
            createdPageCount,
            renamedPageCount,
            mergedPageCount,
            matches,
          },
        );
        context.logger.info(
          "Namespace conversion completed: {matchCount} matches, {changedFileCount} files changed",
          { matchCount: matches.length, changedFileCount: changedPaths.size },
        );
        return { dataHandles: [handle] };
      },
    },
    updatePagePropertyAndTag: {
      description:
        "Update matching page properties and add a tag to each matching page",
      arguments: UpdatePagePropertyAndTagArgsSchema,
      execute: async (
        args: UpdatePagePropertyAndTagArgs,
        context: Context,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const graphPath = context.globalArgs.graphPath.replace(/\/$/, "");
        context.logger.info(
          "Updating pages with {propertyKey}={fromValue} in {graphPath}",
          {
            propertyKey: args.propertyKey,
            fromValue: args.fromValue,
            graphPath,
          },
        );
        const propertyKey = args.propertyKey;
        const tag = args.tag.startsWith("#") ? args.tag : `#${args.tag}`;
        const matches: Array<{ path: string; title: string }> = [];
        let changedFileCount = 0;
        for (const file of await graphMarkdown(graphPath)) {
          if (!file.path.startsWith("pages/")) continue;
          const page = parseLogseqFile(file.path, file.source).page;
          const propertyValue = Object.entries(page.properties).find(
            ([key]) =>
              key.toLocaleLowerCase() === propertyKey.toLocaleLowerCase(),
          )?.[1];
          if (
            propertyValue === undefined ||
            normalizedPropertyValue(propertyValue) !==
              normalizedPropertyValue(args.fromValue)
          ) continue;
          matches.push({ path: file.path, title: page.title });
          const updated = updatePagePropertyAndTag(
            file.source,
            propertyKey,
            args.fromValue,
            args.toValue,
            args.tagsProperty,
            tag,
          );
          if (updated !== file.source) {
            await Deno.writeTextFile(`${graphPath}/${file.path}`, updated);
            changedFileCount++;
          }
        }
        const handle = await context.writeResource(
          "pagePropertyUpdate",
          `page-property-update-${propertyKey.toLowerCase()}-${args.fromValue.toLowerCase()}`,
          {
            graphPath,
            scannedAt: new Date().toISOString(),
            matchCount: matches.length,
            changedFileCount,
            propertyKey,
            fromValue: args.fromValue,
            toValue: args.toValue,
            tag,
            matches,
          },
        );
        context.logger.info(
          "Page property update completed: {matchCount} matches, {changedFileCount} files changed",
          { matchCount: matches.length, changedFileCount },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
