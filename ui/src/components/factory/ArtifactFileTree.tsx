"use client";

import { useMemo, useState } from "react";
import type { TicketArtifactFile } from "./types";
import { artifactExtension, imageMimeType } from "./artifact-formats";

type ArtifactTreeNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: ArtifactTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      file: TicketArtifactFile;
    };

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: TicketArtifactFile[];
}

interface FileTypeInfo {
  label: string;
  badge: string;
  color: string;
}

const TYPES: Record<string, FileTypeInfo> = {
  md: { label: "Markdown", badge: "MD", color: "#60a5fa" },
  mdx: { label: "Markdown", badge: "MD", color: "#60a5fa" },
  html: { label: "HTML", badge: "HTML", color: "#fb923c" },
  htm: { label: "HTML", badge: "HTML", color: "#fb923c" },
  json: { label: "JSON", badge: "{}", color: "#facc15" },
  jsonl: { label: "JSON", badge: "{}", color: "#facc15" },
  yaml: { label: "YAML", badge: "YML", color: "#f472b6" },
  yml: { label: "YAML", badge: "YML", color: "#f472b6" },
  toml: { label: "TOML", badge: "TOML", color: "#f472b6" },
  xml: { label: "XML", badge: "XML", color: "#f97316" },
  csv: { label: "CSV", badge: "CSV", color: "#4ade80" },
  tsv: { label: "TSV", badge: "TSV", color: "#4ade80" },
  pdf: { label: "PDF", badge: "PDF", color: "#f87171" },
  txt: { label: "Text", badge: "TXT", color: "#a1a1aa" },
  text: { label: "Text", badge: "TXT", color: "#a1a1aa" },
  log: { label: "Log", badge: "LOG", color: "#a3e635" },
  out: { label: "Log", badge: "LOG", color: "#a3e635" },
  trace: { label: "Log", badge: "LOG", color: "#a3e635" },
};

const CODE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cpp", "cs", "css", "fish", "go", "h", "hpp",
  "java", "js", "jsx", "kt", "kts", "less", "mjs", "cjs", "php", "py",
  "rb", "rs", "sass", "scss", "sh", "sql", "svelte", "swift", "ts", "tsx",
  "vue", "zsh",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip",
]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "odt", "pages", "rtf"]);
const SPREADSHEET_EXTENSIONS = new Set(["numbers", "ods", "xls", "xlsx"]);
const PRESENTATION_EXTENSIONS = new Set(["key", "odp", "ppt", "pptx"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "mkv", "mov", "mp4", "webm"]);
const CONFIG_EXTENSIONS = new Set(["conf", "env", "ini", "lock", "properties"]);

function fileType(name: string): FileTypeInfo {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const ext = artifactExtension(name);
  if (TYPES[ext]) return TYPES[ext];
  if (CODE_EXTENSIONS.has(ext)) {
    return { label: "Code", badge: ext.toUpperCase().slice(0, 4), color: "#c084fc" };
  }
  if (imageMimeType(name) !== undefined) {
    return { label: "Image", badge: "IMG", color: "#22d3ee" };
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return { label: "Archive", badge: "ZIP", color: "#fbbf24" };
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return { label: "Document", badge: "DOC", color: "#38bdf8" };
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return { label: "Spreadsheet", badge: "XLS", color: "#4ade80" };
  }
  if (PRESENTATION_EXTENSIONS.has(ext)) {
    return { label: "Presentation", badge: "PPT", color: "#fb923c" };
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { label: "Audio", badge: "AUD", color: "#e879f9" };
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { label: "Video", badge: "VID", color: "#f472b6" };
  }
  if (
    CONFIG_EXTENSIONS.has(ext) ||
    ["Dockerfile", "Makefile", "Procfile"].includes(base)
  ) {
    return { label: "Config", badge: "CFG", color: "#94a3b8" };
  }
  return { label: "File", badge: "FILE", color: "#71717a" };
}

function finishFolder(folder: MutableFolder): ArtifactTreeNode[] {
  const folders: ArtifactTreeNode[] = [...folder.folders.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => ({
      kind: "folder",
      name: child.name,
      path: child.path,
      children: finishFolder(child),
    }));
  const files: ArtifactTreeNode[] = [...folder.files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => ({
      kind: "file",
      name: file.name.slice(file.name.lastIndexOf("/") + 1),
      file,
    }));
  return [...folders, ...files];
}

function buildTree(files: TicketArtifactFile[]): ArtifactTreeNode[] {
  const root: MutableFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  for (const file of files) {
    const parts = file.name.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.folders.get(part);
      if (!child) {
        child = { name: part, path, folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return finishFolder(root);
}

function folderPaths(nodes: ArtifactTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (items: ArtifactTreeNode[]) => {
    for (const item of items) {
      if (item.kind !== "folder") continue;
      paths.add(item.path);
      visit(item.children);
    }
  };
  visit(nodes);
  return paths;
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 16" className="h-4 w-5 shrink-0">
      <path
        d={
          open
            ? "M1.5 4.5h17l-2 9H3.3L1.5 4.5Zm1-3h5l1.7 2H18v1H2.5v-3Z"
            : "M1.5 2h6l1.7 2H18v10H1.5V2Z"
        }
        fill="currentColor"
        className="text-amber-400/80"
      />
    </svg>
  );
}

function FileTypeIcon({ name }: { name: string }) {
  const type = fileType(name);
  return (
    <span
      role="img"
      aria-label={`${type.label} file`}
      title={`${type.label} file`}
      className="relative h-5 w-5 shrink-0"
      style={{ color: type.color }}
    >
      <svg aria-hidden="true" viewBox="0 0 20 22" className="h-5 w-5">
        <path
          d="M3 1.5h9l5 5V20.5H3V1.5Z"
          fill="currentColor"
          fillOpacity="0.12"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path d="M12 1.5v5h5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <text
          x="10"
          y="16"
          textAnchor="middle"
          fontSize={type.badge.length > 3 ? "4" : "5"}
          fontWeight="700"
          fill="currentColor"
        >
          {type.badge}
        </text>
      </svg>
    </span>
  );
}

function TreeNodes({
  nodes,
  depth,
  collapsed,
  selectedRelPath,
  onToggleFolder,
  onSelectFile,
}: {
  nodes: ArtifactTreeNode[];
  depth: number;
  collapsed: Set<string>;
  selectedRelPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (relPath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "folder") {
          const isCollapsed = collapsed.has(node.path);
          return (
            <li key={`folder:${node.path}`} role="treeitem" aria-expanded={!isCollapsed}>
              <button
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} folder ${node.name}`}
                onClick={() => onToggleFolder(node.path)}
                className="flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                <span aria-hidden className="w-2 shrink-0 text-[9px] text-zinc-600">
                  {isCollapsed ? "▸" : "▾"}
                </span>
                <FolderIcon open={!isCollapsed} />
                <span className="truncate">{node.name}</span>
              </button>
              {!isCollapsed && (
                <ul role="group">
                  <TreeNodes
                    nodes={node.children}
                    depth={depth + 1}
                    collapsed={collapsed}
                    selectedRelPath={selectedRelPath}
                    onToggleFolder={onToggleFolder}
                    onSelectFile={onSelectFile}
                  />
                </ul>
              )}
            </li>
          );
        }

        const selected = node.file.relPath === selectedRelPath;
        return (
          <li key={node.file.relPath} role="treeitem" aria-selected={selected}>
            <button
              type="button"
              title={node.file.name}
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelectFile(node.file.relPath)}
              className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs ${
                selected
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
              style={{ paddingLeft: 20 + depth * 14 }}
            >
              <FileTypeIcon name={node.name} />
              <span className="truncate">{node.name}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}

export function ArtifactFileTree({
  files,
  selectedRelPath,
  onSelectFile,
}: {
  files: TicketArtifactFile[];
  selectedRelPath: string | null;
  onSelectFile: (relPath: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    folderPaths(tree),
  );

  const toggleFolder = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <ul role="tree" aria-label="Ticket artifact tree">
      <TreeNodes
        nodes={tree}
        depth={0}
        collapsed={collapsed}
        selectedRelPath={selectedRelPath}
        onToggleFolder={toggleFolder}
        onSelectFile={onSelectFile}
      />
    </ul>
  );
}
