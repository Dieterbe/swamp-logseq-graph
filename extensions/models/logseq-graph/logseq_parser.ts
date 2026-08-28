/** Parsed Logseq page. */
export interface ParsedPage {
  path: string;
  title: string;
  namespace: string[];
  properties: Record<string, string>;
  links: string[];
  tags: string[];
  blockRefs: string[];
  blockCount: number;
}

/** Parsed Logseq block. */
export interface ParsedBlock {
  id: string;
  page: string;
  path: string;
  line: number;
  depth: number;
  content: string;
  properties: Record<string, string>;
  links: string[];
  tags: string[];
  blockRefs: string[];
}

/** Result of parsing one Markdown file. */
export interface ParsedFile {
  page: ParsedPage;
  blocks: ParsedBlock[];
}

const PROPERTY = /^\s*([\p{L}\p{N}_-]+)::\s*(.*)$/u;
const BLOCK = /^(\s*)[-*+]\s+(.*)$/;
const PAGE_REF = /\[\[([^\]]+)\]\]/g;
const BLOCK_REF = /\(\(([0-9a-fA-F-]{8,})\)\)/g;
const TAG = /(?:^|\s)#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))/gu;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function matches(text: string, expression: RegExp, group = 1): string[] {
  expression.lastIndex = 0;
  return [...text.matchAll(expression)].map((match) =>
    match[group]?.trim() ?? ""
  );
}

function references(
  text: string,
): { links: string[]; tags: string[]; blockRefs: string[] } {
  TAG.lastIndex = 0;
  const tags = [...text.matchAll(TAG)].map((match) =>
    (match[1] ?? match[2] ?? "").trim()
  );
  return {
    links: unique([...matches(text, PAGE_REF), ...tags]),
    tags: unique(tags),
    blockRefs: unique(matches(text, BLOCK_REF)),
  };
}

function pageTitle(relativePath: string, source: string): string {
  const titleProperty = source.match(/^title::\s*(.+)$/im)?.[1]?.trim();
  if (titleProperty) return titleProperty;
  const fileName = relativePath.split("/").at(-1)?.replace(/\.md$/i, "") ??
    relativePath;
  return fileName.replace(/___/g, "/");
}

/** Parse a Logseq Markdown page without changing it. */
export function parseLogseqFile(
  relativePath: string,
  source: string,
): ParsedFile {
  const title = pageTitle(relativePath, source);
  const pageProperties: Record<string, string> = {};
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | undefined;
  let pagePreamble = true;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const blockMatch = line.match(BLOCK);
    if (blockMatch) {
      pagePreamble = false;
      const content = blockMatch[2];
      const refs = references(content);
      const explicitId = content.match(/\bid::\s*([0-9a-fA-F-]{8,})\b/)?.[1];
      current = {
        id: explicitId ?? `${relativePath}:${index + 1}`,
        page: title,
        path: relativePath,
        line: index + 1,
        depth: Math.floor(blockMatch[1].replace(/\t/g, "  ").length / 2),
        content,
        properties: {},
        ...refs,
      };
      blocks.push(current);
      continue;
    }

    const propertyMatch = line.match(PROPERTY);
    if (propertyMatch) {
      const [, key, value] = propertyMatch;
      if (pagePreamble) pageProperties[key] = value;
      else if (current) {
        current.properties[key] = value;
        if (key === "id" && /^[0-9a-fA-F-]{8,}$/.test(value)) {
          current.id = value;
        }
      }
      continue;
    }

    if (line.trim() && !line.trimStart().startsWith("#")) pagePreamble = false;
  }

  const allText = source;
  const refs = references(allText);
  return {
    page: {
      path: relativePath,
      title,
      namespace: title.split("/").slice(0, -1),
      properties: pageProperties,
      links: refs.links,
      tags: refs.tags,
      blockRefs: refs.blockRefs,
      blockCount: blocks.length,
    },
    blocks,
  };
}
