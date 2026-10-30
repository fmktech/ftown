# Session HTML preview

A session can register one self-contained UTF-8 `.html` or `.htm` file up to 1 MiB from its working directory:

```sh
ftown sessions preview ./preview.html
```

The command uses `FTOWN_SESSION_ID`, or an explicit `--session-id <id>`. Relative paths resolve from the CLI's current directory. It checks bridge support before changing registration; update an older bridge using the setup command in its readiness hint.

The preview supports inline CSS and JavaScript and data images. Sibling assets, external resources, and network requests are not supported. For coherent refreshes, write the complete new document to a temporary file in the same directory and atomically rename it over the registered file. A reload resets the preview's own interactive state; closing the pane keeps the registration and file. To remove the registration without deleting the file:

```sh
ftown sessions preview --clear
```

If the file disappears, the dashboard reports it missing and can recover when the same file returns. The preview runs in an isolated iframe; scripts cannot use the dashboard's parent DOM or storage. This isolation does not limit script CPU or make arbitrary HTML safe to trust.

The iframe blocks ordinary external resource loads and fetches, but this is not complete network isolation: a document can still navigate its own frame. Keep HTML from sources you intend to run. Preview scripts have no FTown messaging or terminal-control capability.
