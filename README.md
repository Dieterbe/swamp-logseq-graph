# @dieter/logseq-graph

Read a local [Logseq](https://logseq.com/) Markdown graph into typed [Swamp](https://swamp-club.com) resources.

The model reads graph content locally and offers targeted migration helpers for journal titles.

## Use

```sh
swamp extension pull @dieter/logseq-graph
swamp model create @dieter/logseq-graph my-graph \
  --global-arg graphPath=/absolute/path/to/graph
swamp model method run my-graph scan
swamp data list my-graph
```

`scan` reads Markdown files directly inside `pages/` and `journals/`. It emits one `page` resource per file, one `block` resource per bullet, and a `summary` resource. Query these resources with `swamp data query`.

## Scheduled items

Use `scheduled` when you only need dated items; it reads the graph and returns a single aggregate resource without rebuilding the full page/block index:

```sh
# Items scheduled for an exact date
swamp model method run my-graph scheduled --input date=2026-08-28

# Items scheduled before that date (overdue)
swamp model method run my-graph scheduled \
  --input date=2026-08-28 --input before=true
```

Results are stored under parameter-specific names, such as `scheduled-2026-08-28-exact` and `scheduled-2026-08-28-before`. Inspect one with:

```sh
swamp data get my-graph scheduled-2026-08-28-before
```

Omit `date` to return every block that has a scheduled date. The `before` selector is strict: it includes dates earlier than the selected date, not the selected date itself.

Every emitted resource includes the scan timestamp. Filter page and block queries to the timestamp in `summary.scannedAt`; this excludes older resources left behind when a page or block was deleted between scans. Keeping historical resources is intentional because Swamp data is versioned, while destructive cleanup would discard audit history.

For example, list artifact names in the full index:

```sh
swamp data query 'modelName == "my-graph"' --select 'data.name'
```

No graph content is sent over the network. All methods except the explicit
`rewriteJournalLinks --input dryRun=false` operation are read-only.

## Journal title migrations

`journalFormats` reads the current `:journal/page-title-format` from
`logseq/config.edn` and distinct earlier values from that file's Git history.
Git history is the source of truth because it records formats that were in use
when existing links were created; inspecting only the working-tree setting
would miss them.

```sh
swamp model method run my-graph journalFormats
swamp model method run my-graph journalLinks
```

`journalLinks` logs and stores every matching filename and complete line. It
only matches links in prior formats, never titles already in the current
format.

Use `rewriteJournalLinks` to migrate those links. Its `dryRun` input defaults
to `true`, so this command is the safe equivalent of `--dry-run`:

```sh
# Preview proposed changes (the default)
swamp model method run my-graph rewriteJournalLinks --input dryRun=true

# Apply after reviewing the preview
swamp model method run my-graph rewriteJournalLinks --input dryRun=false
```

Swamp method inputs use `--input key=value`; it does not expose a model-specific
top-level `--dry-run` flag. The method supports the common Logseq date-fns
tokens used for journal titles: weekday (`EEE`/`EEEE`), day (`d`, `dd`, `do`),
month (`M`, `MM`, `MMM`, `MMMM`), year (`yy`, `yyyy`), literals, and quoted
literals. Other date-fns tokens are not migrated rather than being guessed.

## Supported Logseq syntax

- Page and namespace names, including `___` namespace filenames
- Page properties and block properties (`key:: value`)
- Bullet blocks and nesting depth
- Page references (`[[Page]]`), block references (`((uuid))`), and tags

Only the conventional `pages/` and `journals/` directories are scanned. Recursive assets, org-mode graphs, embedded queries, aliases, and Markdown AST details are not yet interpreted.
