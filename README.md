# @dieter/logseq-graph

Read a local [Logseq](https://logseq.com/) Markdown graph into typed Swamp resources.

The first release is read-only because silently rewriting Markdown risks losing formatting or conflicting with Logseq. A generic Markdown corpus model was considered, but it does not represent Logseq blocks, page references, block references, properties, tags, or namespaces.

## Use

```sh
swamp extension pull @dieter/logseq-graph
swamp model create @dieter/logseq-graph my-graph \
  --global-arg graphPath=/absolute/path/to/graph
swamp model method run my-graph scan
swamp data list my-graph
```

`scan` reads Markdown files directly inside `pages/` and `journals/`. It emits one `page` resource per file, one `block` resource per bullet, and a `summary` resource. Query these resources with `swamp data query`.

Every emitted resource includes the scan timestamp. Filter page and block queries to the timestamp in `summary.scannedAt`; this excludes older resources left behind when a page or block was deleted between scans. Keeping historical resources is intentional because Swamp data is versioned, while destructive cleanup would discard audit history.

For example, find blocks that link to a particular page:

```sh
swamp data query my-graph '"Roadmap" in attributes.links'
```

No graph content is sent over the network. The model does not modify graph files.

## Supported Logseq syntax

- Page and namespace names, including `___` namespace filenames
- Page properties and block properties (`key:: value`)
- Bullet blocks and nesting depth
- Page references (`[[Page]]`), block references (`((uuid))`), and tags

Only the conventional `pages/` and `journals/` directories are scanned. Recursive assets, org-mode graphs, embedded queries, aliases, and Markdown AST details are not yet interpreted.
