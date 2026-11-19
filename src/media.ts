// Content blocks for the native Google Decisions API (provider "google"): text, image, audio, video, PDF.
// Local files are read here, inside a root directory, and sent inline as base64; https URIs are passed through.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type MediaKind = "image" | "audio" | "video" | "document";
export type Resolution = "low" | "medium" | "high" | "ultra_high";

export interface InputBlock {
  type: "text" | MediaKind;
  text?: string;
  path?: string; // local file, resolved under JEV_MEDIA_ROOT (default: cwd)
  uri?: string; // https URL or Files API URI, passed to Google as is
  data?: string; // base64, passed as is
  mime_type?: string;
  resolution?: Resolution; // image and video only
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  wav: "audio/wav", mp3: "audio/mpeg", aiff: "audio/aiff", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  m4a: "audio/m4a", opus: "audio/opus", weba: "audio/webm",
  mp4: "video/mp4", mpeg: "video/mpeg", mov: "video/mov", avi: "video/avi", webm: "video/webm", wmv: "video/wmv",
  flv: "video/x-flv", "3gp": "video/3gpp",
  pdf: "application/pdf",
};

/** Google rejects inline payloads over 100 MB (50 MB for PDFs); this cap is lower on purpose, override with JEV_MEDIA_MAX_BYTES. */
const maxBytes = () => Number(process.env.JEV_MEDIA_MAX_BYTES) || 20 * 1024 * 1024;

export function mimeFor(file: string): string | undefined {
  return MIME[path.extname(file).slice(1).toLowerCase()];
}

/** Resolve `file` under `root` and refuse anything that escapes it, symlinks included. */
export async function safePath(file: string, root = process.env.JEV_MEDIA_ROOT || process.cwd()): Promise<string> {
  const realRoot = await realpath(root);
  const real = await realpath(path.resolve(realRoot, file));
  const rel = path.relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Media path is outside JEV_MEDIA_ROOT (${realRoot}): ${file}`);
  }
  return real;
}

/** Turn one tool-level block into a Google content block. */
export async function loadBlock(block: InputBlock): Promise<Record<string, unknown>> {
  if (block.type === "text") {
    if (typeof block.text !== "string") throw new Error("A text block needs `text`.");
    return { type: "text", text: block.text };
  }
  const sources = [block.path, block.uri, block.data].filter((v) => v !== undefined).length;
  if (sources !== 1) throw new Error(`A ${block.type} block needs exactly one of path, uri or data.`);
  const out: Record<string, unknown> = { type: block.type };
  if (block.resolution) {
    if (block.type !== "image" && block.type !== "video") throw new Error("`resolution` applies to image and video blocks only.");
    out.resolution = block.resolution;
  }
  if (block.path !== undefined) {
    const real = await safePath(block.path);
    const { size } = await stat(real);
    if (size > maxBytes()) throw new Error(`${block.path} is ${size} bytes; the inline cap is ${maxBytes()}. Upload it with the Files API and pass its uri.`);
    const mime = block.mime_type ?? mimeFor(real);
    if (!mime) throw new Error(`Cannot infer a MIME type for ${block.path}; pass mime_type.`);
    return { ...out, data: (await readFile(real)).toString("base64"), mime_type: mime };
  }
  if (block.mime_type === undefined) throw new Error("uri and data blocks need mime_type.");
  if (block.uri !== undefined && !/^https:\/\//i.test(block.uri)) throw new Error("uri must be https (a public URL, a signed URL or a Files API URI).");
  return { ...out, ...(block.uri !== undefined ? { uri: block.uri } : { data: block.data }), mime_type: block.mime_type };
}
