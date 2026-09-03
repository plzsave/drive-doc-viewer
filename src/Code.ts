import type {
  InitialRequest,
  OpenDocumentRequest,
  OpenedDocument,
  PackageFile,
  PackageFileResult,
} from "./types";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES_PER_CALL = 30;
const MAX_PACKAGE_BYTES_PER_CALL = 8 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

const TEXT_EXTENSIONS = new Set([
  "html", "htm", "md", "markdown", "css", "js", "mjs", "json", "txt", "csv", "xml", "svg",
]);

function extension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDriveInput(input: string): { id: string; resourceKey: string } {
  const value = String(input || "").trim();
  if (!value) throw new Error("Google Driveの共有URLまたはファイルIDを入力してください。");

  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) {
    return { id: value, resourceKey: "" };
  }

  if (!/^https:\/\/(?:drive|docs)\.google\.com\//i.test(value)) {
    throw new Error("Google DriveのファイルURL、またはファイルIDを入力してください。");
  }

  const pathMatch = /\/d\/([A-Za-z0-9_-]{10,})/i.exec(value);
  const idMatch = /[?&]id=([A-Za-z0-9_-]{10,})/i.exec(value);
  const id = pathMatch?.[1] || idMatch?.[1] || "";
  const keyMatch = /[?&]resourcekey=([^&#]+)/i.exec(value);
  const resourceKey = keyMatch ? decodeURIComponent(keyMatch[1]) : "";
  if (!id) throw new Error("URLからDriveファイルIDを読み取れませんでした。");
  return { id, resourceKey };
}

function resolveRequest(request: OpenDocumentRequest): { id: string; resourceKey: string } {
  if (request && request.id) {
    const id = String(request.id).trim();
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error("ファイルIDが不正です。");
    return { id, resourceKey: String(request.resourceKey || "").trim() };
  }
  return parseDriveInput(String(request?.input || ""));
}

function getDriveFile(id: string, resourceKey: string): GoogleAppsScript.Drive.File {
  try {
    return resourceKey
      ? DriveApp.getFileByIdAndResourceKey(id, resourceKey)
      : DriveApp.getFileById(id);
  } catch (_error) {
    throw new Error("ファイルを開けませんでした。URLとDriveの閲覧権限を確認してください。");
  }
}

function parentFolderId(file: GoogleAppsScript.Drive.File): string {
  const parents = file.getParents();
  return parents.hasNext() ? parents.next().getId() : "";
}

function readTextFile(file: GoogleAppsScript.Drive.File): string {
  const size = file.getSize();
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error("ファイルが大きすぎます（4MBまで）。");
  }
  return file.getBlob().getDataAsString("UTF-8");
}

export function openDriveDocument(request: OpenDocumentRequest): OpenedDocument {
  const ref = resolveRequest(request || {});
  const file = getDriveFile(ref.id, ref.resourceKey);
  const name = file.getName();
  const ext = extension(name);
  const kind = ext === "md" || ext === "markdown"
    ? "markdown"
    : ext === "html" || ext === "htm"
      ? "html"
      : null;

  if (!kind) {
    throw new Error("対応形式は .md / .markdown / .html / .htm です。");
  }

  return {
    id: file.getId(),
    name,
    kind,
    mimeType: MIME_BY_EXTENSION[ext] || file.getMimeType(),
    content: readTextFile(file),
    lastUpdated: file.getLastUpdated().getTime(),
    packageRootId: parentFolderId(file),
    entryPath: name,
    appUrl: ScriptApp.getService().getUrl() || "",
  };
}

function normalizePackagePath(path: string): string[] {
  const value = String(path || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new Error("相対パスが不正です。");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("相対パスが不正です。");
  }
  return parts;
}

function uniqueChildFolder(
  folder: GoogleAppsScript.Drive.Folder,
  name: string,
): GoogleAppsScript.Drive.Folder {
  const matches = folder.getFoldersByName(name);
  if (!matches.hasNext()) throw new Error(`フォルダが見つかりません: ${name}`);
  const child = matches.next();
  if (matches.hasNext()) throw new Error(`同名フォルダが複数あります: ${name}`);
  return child;
}

function uniqueChildFile(
  folder: GoogleAppsScript.Drive.Folder,
  name: string,
): GoogleAppsScript.Drive.File {
  const matches = folder.getFilesByName(name);
  if (!matches.hasNext()) throw new Error(`ファイルが見つかりません: ${name}`);
  const file = matches.next();
  if (matches.hasNext()) throw new Error(`同名ファイルが複数あります: ${name}`);
  return file;
}

function resolvePackageFile(
  root: GoogleAppsScript.Drive.Folder,
  path: string,
): GoogleAppsScript.Drive.File {
  const parts = normalizePackagePath(path);
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    folder = uniqueChildFolder(folder, part);
  }
  return uniqueChildFile(folder, parts[parts.length - 1]);
}

function encodePackageFile(path: string, file: GoogleAppsScript.Drive.File): PackageFile {
  const ext = extension(file.getName());
  const mimeType = MIME_BY_EXTENSION[ext];
  if (!mimeType) throw new Error(`未対応の関連ファイル形式です: .${ext || "(拡張子なし)"}`);
  const size = file.getSize();
  if (size > MAX_DOCUMENT_BYTES) throw new Error("関連ファイルが大きすぎます（4MBまで）。");
  const blob = file.getBlob();
  const isText = TEXT_EXTENSIONS.has(ext);
  return {
    path,
    mimeType,
    encoding: isText ? "text" : "base64",
    content: isText ? blob.getDataAsString("UTF-8") : Utilities.base64Encode(blob.getBytes()),
    size,
  };
}

export function getPackageFiles(rootFolderId: string, paths: string[]): PackageFileResult[] {
  if (!rootFolderId) throw new Error("関連ファイルの基準フォルダがありません。");
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (paths.length > MAX_PACKAGE_FILES_PER_CALL) {
    throw new Error(`関連ファイルは一度に${MAX_PACKAGE_FILES_PER_CALL}件まで取得できます。`);
  }

  let root: GoogleAppsScript.Drive.Folder;
  try {
    root = DriveApp.getFolderById(String(rootFolderId));
  } catch (_error) {
    throw new Error("関連ファイルの基準フォルダを開けませんでした。");
  }

  let totalBytes = 0;
  return paths.map((rawPath) => {
    const path = String(rawPath || "");
    try {
      const encoded = encodePackageFile(path, resolvePackageFile(root, path));
      totalBytes += encoded.size;
      if (totalBytes > MAX_PACKAGE_BYTES_PER_CALL) {
        throw new Error("一度に読み込める関連ファイルは合計8MBまでです。");
      }
      return { path, ok: true, file: encoded };
    } catch (error) {
      return { path, ok: false, error: messageOf(error) };
    }
  });
}

function parseInitialRequest(event: GoogleAppsScript.Events.DoGet): InitialRequest {
  const directId = String(event?.parameter?.id || "");
  if (/^[A-Za-z0-9_-]{10,}$/.test(directId)) {
    return {
      id: directId,
      resourceKey: String(event.parameter.resourceKey || event.parameter.resourcekey || ""),
    };
  }

  const stateValue = String(event?.parameter?.state || "");
  if (!stateValue) return { id: "", resourceKey: "" };
  try {
    let parsed: { action?: string; ids?: unknown; resourceKeys?: Record<string, string> };
    try {
      parsed = JSON.parse(stateValue);
    } catch (_error) {
      parsed = JSON.parse(decodeURIComponent(stateValue));
    }
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    const id = parsed.action === "open" && typeof ids[0] === "string" ? ids[0] : "";
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return { id: "", resourceKey: "" };
    return { id, resourceKey: String(parsed.resourceKeys?.[id] || "") };
  } catch (_error) {
    return { id: "", resourceKey: "" };
  }
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function doGet(event: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile("index");
  (template as unknown as { initialRequestJson: string }).initialRequestJson =
    safeJsonForHtml(parseInitialRequest(event));
  return template.evaluate()
    .setTitle("Drive Doc Viewer — Drive文書の閲覧台");
}
