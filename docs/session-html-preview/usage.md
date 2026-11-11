# Session file preview

A session can register up to 12 files, each a UTF-8 HTML or Markdown document
of at most 1 MiB from its working directory:

```sh
ftown sessions preview ./preview.html ./notes.md
```

The command uses `FTOWN_SESSION_ID`, or an explicit `--session-id <id>`. Relative paths resolve from the CLI's current directory. It checks bridge support before changing registration; update an older bridge using the setup command in its readiness hint.

Kind is decided by extension, case-insensitive: `.html`/`.htm` → HTML,
`.md`/`.markdown` → Markdown. Anything else is rejected. Two registered files
may not share a basename (the selector and links are by basename): a duplicate
basename is rejected with a clear error naming it. Registration is
all-or-nothing — if any path fails validation or the set would exceed 12
files, nothing changes and the error names the offending path.

## Four command forms

```sh
ftown sessions preview <path...>          # replace the whole set with these files, in this order
ftown sessions preview --add <path...>    # append to the current set
ftown sessions preview --remove <name...> # remove by basename; removing the last file clears the preview
ftown sessions preview --clear            # remove the whole registration, without deleting files
```

`--add`, `--remove`, and `--clear` are mutually exclusive. No paths and no flag is a usage error. A path already registered and added again stays in its position with a new file id. Use `--session-id <id>` for an explicit target session. Closing the dashboard preview does not clear the registration; to remove the registration without deleting the files:

```sh
ftown sessions preview --clear
```

## HTML previews

HTML previews are self-contained documents. Inline CSS and JavaScript and data images are supported. Sibling assets, external resources, and network requests are not supported. For coherent refreshes, write the complete new document to a temporary file in the same directory and atomically rename it over the registered file. A reload resets the preview's own interactive state; closing the pane keeps the registration and file.

## Markdown previews

Markdown is rendered as a readable document with GFM — tables, task lists, strikethrough, fenced code — inside the same sandbox iframe as HTML. No network access; only `data:` images work. Raw HTML written inside the markdown passes through into that same iframe, so it is isolated exactly like an HTML preview: no dashboard-origin access, no form submission. Markdown is never rendered into the parent dashboard page.

## Switching between files

With two or more registered files, the dashboard shows a file selector in the preview toolbar. A relative link in a preview whose basename matches another registered file (ignoring `./`, query and `#fragment`) switches the selector to that file instead of opening the default behavior. All other links behave as before. Only the selected file is fetched; switching shows a loading state rather than the previous file's content.

## Isolation

The preview runs in an isolated iframe; scripts cannot use the dashboard's parent DOM or storage. This isolation does not limit script CPU or make arbitrary HTML safe to trust.

The iframe blocks ordinary external resource loads and fetches, but this is not complete network isolation: a document can still navigate its own frame. Keep HTML from sources you intend to run. Preview scripts have no FTown messaging or terminal-control capability of their own. Messages from the preview conversation arrive as ftown mail; there is one conversation per session, unchanged. Reply with `ftown sessions preview-reply --message "…"`.

If the file disappears, the dashboard reports it missing and can recover when the same file returns.
