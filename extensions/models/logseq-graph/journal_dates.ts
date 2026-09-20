/** Journal-title format history and Markdown link migration helpers. */

export interface JournalFormat {
  format: string;
  isCurrent: boolean;
}

export interface JournalLinkMatch {
  path: string;
  line: number;
  content: string;
  link: string;
  sourceFormat: string;
  replacement: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const TOKENS = [
  "yyyy",
  "yy",
  "MMMM",
  "MMM",
  "MM",
  "M",
  "EEEE",
  "EEE",
  "do",
  "dd",
  "d",
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ordinal(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
  return `${day}${suffix}`;
}

function tokenize(format: string): Array<{ value: string; token: boolean }> {
  const parts: Array<{ value: string; token: boolean }> = [];
  for (let index = 0; index < format.length;) {
    if (format[index] === "'") {
      const end = format.indexOf("'", index + 1);
      if (end !== -1) {
        parts.push({ value: format.slice(index + 1, end), token: false });
        index = end + 1;
        continue;
      }
    }
    const token = TOKENS.find((candidate) =>
      format.startsWith(candidate, index)
    );
    if (token) {
      parts.push({ value: token, token: true });
      index += token.length;
    } else {
      parts.push({ value: format[index], token: false });
      index++;
    }
  }
  return parts;
}

/** Format a UTC calendar date using Logseq's common date-fns title tokens. */
export function formatJournalDate(date: Date, format: string): string {
  return tokenize(format).map((part) => {
    if (!part.token) return part.value;
    const day = date.getUTCDate();
    const month = date.getUTCMonth();
    switch (part.value) {
      case "yyyy":
        return String(date.getUTCFullYear()).padStart(4, "0");
      case "yy":
        return String(date.getUTCFullYear() % 100).padStart(2, "0");
      case "MMMM":
        return MONTHS[month];
      case "MMM":
        return MONTHS[month].slice(0, 3);
      case "MM":
        return String(month + 1).padStart(2, "0");
      case "M":
        return String(month + 1);
      case "EEEE":
        return WEEKDAYS[date.getUTCDay()];
      case "EEE":
        return WEEKDAYS[date.getUTCDay()].slice(0, 3);
      case "do":
        return ordinal(day);
      case "dd":
        return String(day).padStart(2, "0");
      case "d":
        return String(day);
      default:
        return part.value;
    }
  }).join("");
}

/** Parse a journal title that exactly matches a common Logseq date-fns format. */
export function parseJournalDate(title: string, format: string): Date | null {
  const fields: string[] = [];
  const expression = tokenize(format).map((part) => {
    if (!part.token) return escapeRegex(part.value);
    fields.push(part.value);
    switch (part.value) {
      case "yyyy":
        return "(\\d{4})";
      case "yy":
        return "(\\d{2})";
      case "MMMM":
        return "([A-Za-z]+)";
      case "MMM":
        return "([A-Za-z]{3})";
      case "MM":
        return "(\\d{2})";
      case "M":
        return "(\\d{1,2})";
      case "EEEE":
        return "([A-Za-z]+)";
      case "EEE":
        return "([A-Za-z]{3})";
      case "do":
        return "(\\d{1,2}(?:st|nd|rd|th))";
      case "dd":
        return "(\\d{2})";
      case "d":
        return "(\\d{1,2})";
      default:
        return escapeRegex(part.value);
    }
  }).join("");
  const match = new RegExp(`^${expression}$`, "i").exec(title);
  if (!match) return null;

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  for (const [index, field] of fields.entries()) {
    const value = match[index + 1];
    if (field === "yyyy") year = Number(value);
    if (field === "yy") year = 2000 + Number(value);
    if (["MMMM", "MMM"].includes(field)) {
      month = MONTHS.map((name) =>
        name.toLowerCase()
      ).findIndex((name) => name.startsWith(value.toLowerCase())) + 1;
    }
    if (["MM", "M"].includes(field)) month = Number(value);
    if (["do", "dd", "d"].includes(field)) day = Number.parseInt(value, 10);
  }
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ? date
    : null;
}

function formatFromConfig(source: string): string | null {
  const match = /^\s*:journal\/page-title-format\s+"((?:\\.|[^"\\])*)"/m.exec(
    source,
  );
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

async function git(graphPath: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd: graphPath,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || "git command failed",
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Read the configured title format and every distinct historical format in Git. */
export async function journalFormats(
  graphPath: string,
): Promise<JournalFormat[]> {
  const configPath = `${graphPath.replace(/\/$/, "")}/logseq/config.edn`;
  const current = formatFromConfig(await Deno.readTextFile(configPath));
  if (!current) {
    throw new Error(`No :journal/page-title-format found in ${configPath}`);
  }

  const commits =
    (await git(graphPath, ["log", "--format=%H", "--", "logseq/config.edn"]))
      .trim().split(/\s+/).filter(Boolean);
  const formats = new Set<string>();
  for (const commit of commits) {
    const result = await new Deno.Command("git", {
      args: ["show", `${commit}:logseq/config.edn`],
      cwd: graphPath,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) continue;
    const format = formatFromConfig(new TextDecoder().decode(result.stdout));
    if (format) formats.add(format);
  }
  formats.delete(current);
  return [
    { format: current, isCurrent: true },
    ...[...formats].sort().map((format) => ({ format, isCurrent: false })),
  ];
}

/** Find links using a historical journal title and calculate their current replacement. */
export function findJournalLinks(
  files: Array<{ path: string; source: string }>,
  formats: JournalFormat[],
): JournalLinkMatch[] {
  const current = formats.find((format) => format.isCurrent)?.format;
  if (!current) throw new Error("A current journal title format is required");
  const oldFormats = formats.filter((format) => !format.isCurrent).map((
    format,
  ) => format.format);
  const matches: JournalLinkMatch[] = [];
  for (const file of files) {
    for (const [index, content] of file.source.split(/\r?\n/).entries()) {
      for (const link of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
        for (const sourceFormat of oldFormats) {
          const date = parseJournalDate(link[1], sourceFormat);
          if (!date) continue;
          matches.push({
            path: file.path,
            line: index + 1,
            content,
            link: link[0],
            sourceFormat,
            replacement: `[[${formatJournalDate(date, current)}]]`,
          });
          break;
        }
      }
    }
  }
  return matches;
}
