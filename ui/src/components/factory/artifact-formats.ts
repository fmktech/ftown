export const IMAGE_MIME_TYPES = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
} as const satisfies Record<string, string>;

export function artifactExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME_TYPES[
    artifactExtension(path) as keyof typeof IMAGE_MIME_TYPES
  ];
}
