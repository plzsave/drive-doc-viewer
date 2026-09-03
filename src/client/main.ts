declare const google: any;
declare const marked: any;
declare const DOMPurify: any;
declare const hljs: any;

interface InitialRequest {
  id: string;
  resourceKey: string;
}

interface OpenedDocument {
  id: string;
  name: string;
  kind: "markdown" | "html";
  mimeType: string;
  content: string;
  lastUpdated: number;
  packageRootId: string;
  entryPath: string;
  appUrl: string;
}

interface PackageFile {
  path: string;
  mimeType: string;
  encoding: "text" | "base64";
  content: string;
  size: number;
}

interface PackageFileResult {
  path: string;
  ok: boolean;
  file?: PackageFile;
  error?: string;
}

interface Window {
  __INITIAL_REQUEST__?: InitialRequest;
  mermaid?: any;
}

const MAX_PACKAGE_FILES = 100;
const PACKAGE_BATCH_SIZE = 30;
const THEME_STORAGE_KEY = "drive-doc-viewer-theme";

const openCard = byId<HTMLElement>("open-card");
const openPanelToggle = byId<HTMLButtonElement>("open-panel-toggle");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");
const themeIcon = byId<HTMLSpanElement>("theme-icon");
const themeLabel = byId<HTMLSpanElement>("theme-label");
const highlightLight = byId<HTMLLinkElement>("highlight-light");
const highlightDark = byId<HTMLLinkElement>("highlight-dark");
const openForm = byId<HTMLFormElement>("open-form");
const urlInput = byId<HTMLInputElement>("url-input");
const openButton = byId<HTMLButtonElement>("open-button");
const messageBox = byId<HTMLDivElement>("message");
const viewer = byId<HTMLElement>("viewer");
const viewerBody = byId<HTMLDivElement>("viewer-body");
const fileName = byId<HTMLHeadingElement>("file-name");
const fileDetail = byId<HTMLDivElement>("file-detail");
const typeBadge = byId<HTMLSpanElement>("type-badge");
const copyLinkButton = byId<HTMLButtonElement>("copy-link");
const closeViewerButton = byId<HTMLButtonElement>("close-viewer");

let currentDocument: OpenedDocument | null = null;
let activeHtmlPreview: HTMLIFrameElement | null = null;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element not found: ${id}`);
  return element as T;
}

function gasRun<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const runner = google.script.run
      .withSuccessHandler((value: T) => resolve(value))
      .withFailureHandler((error: { message?: string } | string) => {
        const raw = typeof error === "string" ? error : error?.message || String(error);
        reject(new Error(raw.replace(/^Exception:\s*/, "")));
      });
    runner[method](...args);
  });
}

function showMessage(text = "", kind: "loading" | "error" | "warning" = "loading"): void {
  messageBox.textContent = text;
  messageBox.className = text ? `message visible ${kind}` : "message";
}

function setBusy(busy: boolean): void {
  openButton.disabled = busy;
  openButton.textContent = busy ? "読み込み中…" : "開く";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function schedulePreviewResize(): void {
  window.requestAnimationFrame(() => {
    if (!activeHtmlPreview?.isConnected) return;
    const top = Math.max(activeHtmlPreview.getBoundingClientRect().top, 64);
    const minimum = window.innerWidth <= 680 ? 320 : 420;
    const available = window.innerHeight - top - 16;
    const maximum = Math.max(minimum, window.innerHeight - 24);
    activeHtmlPreview.style.height = `${Math.max(minimum, Math.min(maximum, available))}px`;
  });
}

function setOpenPanel(visible: boolean, focusInput = false): void {
  openCard.classList.toggle("hidden", !visible);
  openPanelToggle.setAttribute("aria-expanded", String(visible));
  openPanelToggle.textContent = visible ? "入力欄を隠す" : "別のファイルを開く";
  if (visible && focusInput) window.requestAnimationFrame(() => urlInput.focus());
  schedulePreviewResize();
}

function darkModeEnabled(): boolean {
  return document.documentElement.classList.contains("dark");
}

function syncThemeControls(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  highlightLight.disabled = dark;
  highlightDark.disabled = !dark;
  themeIcon.textContent = dark ? "☀" : "☾";
  themeLabel.textContent = dark ? "ライト" : "ダーク";
  const action = dark ? "ライトモードに切り替える" : "ダークモードに切り替える";
  themeToggle.setAttribute("aria-label", action);
  themeToggle.title = action;
}

async function applyTheme(dark: boolean, persist: boolean): Promise<void> {
  syncThemeControls(dark);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
    } catch (_error) {
      // The visual switch still works when browser storage is unavailable.
    }
  }

  // HTML is deliberately left untouched so authored document colors remain exact.
  if (currentDocument?.kind === "markdown") {
    themeToggle.disabled = true;
    try {
      await renderMarkdown(currentDocument);
    } finally {
      themeToggle.disabled = false;
    }
  }
}

function ensureMermaid(): Promise<any> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Mermaidの読み込みがタイムアウトしました。")), 15000);
    window.addEventListener("mermaid-ready", () => {
      window.clearTimeout(timer);
      resolve(window.mermaid);
    }, { once: true });
  });
}

async function renderMermaidBlocks(container: HTMLElement): Promise<boolean> {
  const blocks = [...container.querySelectorAll<HTMLElement>(".mermaid")];
  if (!blocks.length) return true;
  let api: any;
  try {
    api = await ensureMermaid();
    api.initialize({
      startOnLoad: false,
      theme: darkModeEnabled() ? "dark" : "neutral",
      securityLevel: "strict",
    });
  } catch (error) {
    for (const block of blocks) {
      block.className = "mermaid-error";
      block.textContent = errorMessage(error);
    }
    return false;
  }

  let succeeded = true;
  for (const block of blocks) {
    try {
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      const { svg } = await api.render(id, block.textContent || "");
      block.innerHTML = svg;
    } catch (error) {
      succeeded = false;
      block.className = "mermaid-error";
      block.textContent = `Mermaidを描画できませんでした: ${errorMessage(error)}`;
    }
  }
  return succeeded;
}

openPanelToggle.addEventListener("click", () => {
  const willShow = openCard.classList.contains("hidden");
  setOpenPanel(willShow, willShow);
});

themeToggle.addEventListener("click", () => {
  void applyTheme(!darkModeEnabled(), true);
});

const preferredTheme = window.matchMedia("(prefers-color-scheme: dark)");
preferredTheme.addEventListener("change", (event) => {
  try {
    if (localStorage.getItem(THEME_STORAGE_KEY)) return;
  } catch (_error) {
    // Follow the OS while storage is unavailable.
  }
  void applyTheme(event.matches, false);
});

window.addEventListener("resize", schedulePreviewResize);
window.visualViewport?.addEventListener("resize", schedulePreviewResize);

openForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void openDocument({ input: urlInput.value });
});

closeViewerButton.addEventListener("click", () => {
  currentDocument = null;
  activeHtmlPreview = null;
  viewer.classList.remove("visible");
  viewerBody.replaceChildren();
  showMessage();
  setOpenPanel(true, true);
});

copyLinkButton.addEventListener("click", async () => {
  if (!currentDocument?.appUrl) return;
  const url = new URL(currentDocument.appUrl);
  url.searchParams.set("id", currentDocument.id);
  try {
    await navigator.clipboard.writeText(url.toString());
    const original = copyLinkButton.textContent;
    copyLinkButton.textContent = "コピーしました";
    window.setTimeout(() => { copyLinkButton.textContent = original; }, 1600);
  } catch (_error) {
    showMessage("共有URLをコピーできませんでした。", "error");
  }
});

async function openDocument(request: { input?: string; id?: string; resourceKey?: string }): Promise<void> {
  if (!request.id && !String(request.input || "").trim()) {
    showMessage("Google DriveのファイルURLを入力してください。", "error");
    return;
  }

  setBusy(true);
  showMessage("Driveからファイルを読み込んでいます…", "loading");
  try {
    const opened = await gasRun<OpenedDocument>("openDriveDocument", request);
    currentDocument = opened;
    fileName.textContent = opened.name;
    fileDetail.textContent = `更新: ${new Date(opened.lastUpdated).toLocaleString("ja-JP")}`;
    typeBadge.textContent = opened.kind === "markdown" ? "Markdown" : "HTML";
    viewer.classList.add("visible");
    viewerBody.replaceChildren();
    activeHtmlPreview = null;

    if (opened.kind === "markdown") {
      await renderMarkdown(opened);
    } else {
      await renderHtmlDocument(opened);
    }
    const hasWarning = messageBox.classList.contains("warning");
    setOpenPanel(hasWarning);
    viewer.scrollIntoView({ block: "start" });
    schedulePreviewResize();
  } catch (error) {
    viewer.classList.remove("visible");
    activeHtmlPreview = null;
    setOpenPanel(true);
    showMessage(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

function cleanReference(reference: string): string {
  return String(reference || "").trim();
}

function isRemoteReference(reference: string): boolean {
  const ref = cleanReference(reference);
  return /^\/\//.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function isSafeExternalReference(reference: string): boolean {
  return /^(?:https:|mailto:|tel:)/i.test(cleanReference(reference));
}

function resolvePackagePath(fromPath: string, reference: string): string | null {
  const raw = cleanReference(reference);
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || isRemoteReference(raw)) return null;
  const pathOnly = raw.split("#", 1)[0].split("?", 1)[0];
  if (!pathOnly) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly).replace(/\\/g, "/");
  } catch (_error) {
    return null;
  }

  const parts = decoded.startsWith("/")
    ? []
    : fromPath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

function pathExtension(path: string): string {
  const match = /\.([^.\/]+)$/.exec(path);
  return match ? match[1].toLowerCase() : "";
}

function referencesFromCss(path: string, css: string): Set<string> {
  const references = new Set<string>();
  const patterns = [
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(css)) !== null) {
      const resolved = resolvePackagePath(path, match[1]);
      if (resolved) references.add(resolved);
    }
  }
  return references;
}

function referencesFromSrcset(path: string, srcset: string): Set<string> {
  const references = new Set<string>();
  for (const candidate of srcset.split(",")) {
    const ref = candidate.trim().split(/\s+/, 1)[0];
    const resolved = resolvePackagePath(path, ref);
    if (resolved) references.add(resolved);
  }
  return references;
}

function referencesFromHtml(path: string, html: string): Set<string> {
  const references = new Set<string>();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const add = (raw: string | null): void => {
    if (!raw) return;
    const resolved = resolvePackagePath(path, raw);
    if (resolved) references.add(resolved);
  };

  doc.querySelectorAll("iframe[src], img[src], source[src], video[src], audio[src], video[poster], link[href], image[href]")
    .forEach((element) => add(element.getAttribute("src") || element.getAttribute("poster") || element.getAttribute("href")));
  doc.querySelectorAll("img[srcset], source[srcset]").forEach((element) => {
    for (const ref of referencesFromSrcset(path, element.getAttribute("srcset") || "")) references.add(ref);
  });
  doc.querySelectorAll("a[href]").forEach((element) => {
    const raw = element.getAttribute("href") || "";
    const resolved = resolvePackagePath(path, raw);
    if (resolved && /^(?:html?|md|markdown)$/.test(pathExtension(resolved))) references.add(resolved);
  });
  doc.querySelectorAll("style").forEach((element) => {
    for (const ref of referencesFromCss(path, element.textContent || "")) references.add(ref);
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    for (const ref of referencesFromCss(path, element.getAttribute("style") || "")) references.add(ref);
  });
  return references;
}

async function loadHtmlDependencies(opened: OpenedDocument): Promise<{
  files: Map<string, PackageFile>;
  warnings: string[];
}> {
  const files = new Map<string, PackageFile>();
  files.set(opened.entryPath, {
    path: opened.entryPath,
    mimeType: opened.mimeType,
    encoding: "text",
    content: opened.content,
    size: opened.content.length,
  });

  const warnings: string[] = [];
  if (!opened.packageRootId) return { files, warnings };

  const pending: string[] = [...referencesFromHtml(opened.entryPath, opened.content)];
  const requested = new Set<string>();
  while (pending.length && requested.size < MAX_PACKAGE_FILES) {
    const batch: string[] = [];
    while (pending.length && batch.length < PACKAGE_BATCH_SIZE && requested.size < MAX_PACKAGE_FILES) {
      const path = pending.shift()!;
      if (requested.has(path) || files.has(path)) continue;
      requested.add(path);
      batch.push(path);
    }
    if (!batch.length) continue;

    showMessage(`HTMLの関連ファイルを読み込んでいます…（${requested.size}件）`, "loading");
    const results = await gasRun<PackageFileResult[]>("getPackageFiles", opened.packageRootId, batch);
    for (const result of results) {
      if (!result.ok || !result.file) {
        warnings.push(`${result.path}: ${result.error || "読み込めませんでした"}`);
        continue;
      }
      const file = result.file;
      files.set(file.path, file);
      let discovered = new Set<string>();
      if (file.encoding === "text" && /text\/html/.test(file.mimeType)) {
        discovered = referencesFromHtml(file.path, file.content);
      } else if (file.encoding === "text" && /text\/css/.test(file.mimeType)) {
        discovered = referencesFromCss(file.path, file.content);
      }
      for (const path of discovered) {
        if (!requested.has(path) && !files.has(path)) pending.push(path);
      }
    }
  }
  if (pending.length) warnings.push(`関連ファイルが${MAX_PACKAGE_FILES}件を超えたため、残りを省略しました。`);
  return { files, warnings };
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function fileDataUrl(file: PackageFile): string {
  const base64 = file.encoding === "base64" ? file.content : textToBase64(file.content);
  return `data:${file.mimeType};base64,${base64}`;
}

function transformCss(
  path: string,
  css: string,
  files: Map<string, PackageFile>,
  cssStack = new Set<string>(),
): string {
  const nextStack = new Set(cssStack);
  nextStack.add(path);

  let transformed = css.replace(
    /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi,
    (full: string, reference: string) => {
      const resolved = resolvePackagePath(path, reference);
      if (!resolved) return isSafeExternalReference(reference) || reference.trim().startsWith("data:") ? full : "";
      const imported = files.get(resolved);
      if (!imported || imported.encoding !== "text" || !/text\/css/.test(imported.mimeType) || nextStack.has(resolved)) {
        return `/* import unavailable: ${resolved} */`;
      }
      return transformCss(resolved, imported.content, files, nextStack);
    },
  );

  transformed = transformed.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (full: string, _quote: string, reference: string) => {
      if (reference.trim().startsWith("#")) return full;
      const resolved = resolvePackagePath(path, reference);
      if (!resolved) {
        return isSafeExternalReference(reference) || reference.trim().startsWith("data:") ? full : "url(\"\")";
      }
      const asset = files.get(resolved);
      return asset ? `url("${fileDataUrl(asset)}")` : "url(\"\")";
    },
  );
  return transformed;
}

function blockedFrame(doc: Document, label: string): HTMLElement {
  const box = doc.createElement("div");
  box.style.cssText = "padding:12px;border:1px dashed #cbd5e1;background:#f8fafc;color:#64748b;font:13px sans-serif";
  box.textContent = label;
  return box;
}

function rewriteSrcset(path: string, value: string, files: Map<string, PackageFile>): string {
  return value.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    const reference = parts.shift() || "";
    const resolved = resolvePackagePath(path, reference);
    if (!resolved) {
      return isSafeExternalReference(reference) || reference.startsWith("data:") ? candidate.trim() : "";
    }
    const file = files.get(resolved);
    return file ? [fileDataUrl(file), ...parts].join(" ") : "";
  }).filter(Boolean).join(", ");
}

function transformHtml(
  path: string,
  html: string,
  files: Map<string, PackageFile>,
  stack = new Set<string>(),
): string {
  if (stack.has(path)) {
    return "<!doctype html><html><body><p>循環するiframe参照を停止しました。</p></body></html>";
  }
  const nextStack = new Set(stack);
  nextStack.add(path);
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("script, object, embed, applet, base").forEach((element) => element.remove());
  doc.querySelectorAll("meta[http-equiv]").forEach((element) => element.remove());
  doc.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  });
  doc.querySelectorAll("form").forEach((form) => {
    form.removeAttribute("action");
    form.removeAttribute("method");
  });

  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline' https:",
    "img-src data: https:",
    "font-src data: https:",
    "media-src data: https:",
    "frame-src 'self' data: blob: about:",
    "connect-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  doc.head.prepend(csp);

  doc.querySelectorAll<HTMLLinkElement>("link[href]").forEach((link) => {
    const reference = link.getAttribute("href") || "";
    const resolved = resolvePackagePath(path, reference);
    if (link.rel.toLowerCase().split(/\s+/).includes("stylesheet")) {
      if (!resolved) {
        if (!isSafeExternalReference(reference)) link.remove();
        return;
      }
      const css = files.get(resolved);
      if (!css || css.encoding !== "text" || !/text\/css/.test(css.mimeType)) {
        link.remove();
        return;
      }
      const style = doc.createElement("style");
      style.textContent = transformCss(resolved, css.content, files);
      link.replaceWith(style);
      return;
    }
    if (resolved) {
      const asset = files.get(resolved);
      if (asset) link.href = fileDataUrl(asset);
      else link.remove();
    } else if (!isSafeExternalReference(reference)) {
      link.remove();
    }
  });

  doc.querySelectorAll("style").forEach((style) => {
    style.textContent = transformCss(path, style.textContent || "", files);
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    element.setAttribute("style", transformCss(path, element.getAttribute("style") || "", files));
  });

  doc.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame) => {
    const reference = frame.getAttribute("src") || "";
    frame.removeAttribute("srcdoc");
    const resolved = resolvePackagePath(path, reference);
    if (!resolved || !/^(?:html?|md|markdown)$/.test(pathExtension(resolved))) {
      frame.replaceWith(blockedFrame(doc, reference ? `表示対象外のiframe: ${reference}` : "空のiframe"));
      return;
    }
    const child = files.get(resolved);
    if (!child || child.encoding !== "text") {
      frame.replaceWith(blockedFrame(doc, `iframeを読み込めません: ${reference}`));
      return;
    }
    const childHtml = /markdown/.test(child.mimeType)
      ? DOMPurify.sanitize(marked.parse(child.content))
      : child.content;
    frame.removeAttribute("src");
    frame.srcdoc = transformHtml(resolved, childHtml, files, nextStack);
    frame.setAttribute("sandbox", "");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("referrerpolicy", "no-referrer");
  });

  const sourceSelectors = [
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["video[poster]", "poster"],
    ["image[href]", "href"],
  ] as const;
  for (const [selector, attribute] of sourceSelectors) {
    doc.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const reference = element.getAttribute(attribute) || "";
      const resolved = resolvePackagePath(path, reference);
      if (resolved) {
        const asset = files.get(resolved);
        if (asset) element.setAttribute(attribute, fileDataUrl(asset));
        else element.removeAttribute(attribute);
      } else if (!isSafeExternalReference(reference) && !reference.startsWith("data:")) {
        element.removeAttribute(attribute);
      }
    });
  }
  doc.querySelectorAll<HTMLElement>("img[srcset], source[srcset]").forEach((element) => {
    const rewritten = rewriteSrcset(path, element.getAttribute("srcset") || "", files);
    if (rewritten) element.setAttribute("srcset", rewritten);
    else element.removeAttribute("srcset");
  });

  doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const reference = anchor.getAttribute("href") || "";
    if (reference.startsWith("#")) return;
    const resolved = resolvePackagePath(path, reference);
    if (resolved) {
      const target = files.get(resolved);
      if (!target) {
        anchor.removeAttribute("href");
      } else if (target.encoding === "text" && /text\/html|text\/markdown/.test(target.mimeType)) {
        const linkedHtml = /markdown/.test(target.mimeType)
          ? DOMPurify.sanitize(marked.parse(target.content))
          : target.content;
        anchor.href = `data:text/html;base64,${textToBase64(transformHtml(resolved, linkedHtml, files, nextStack))}`;
        anchor.target = "_self";
      } else {
        anchor.href = fileDataUrl(target);
        anchor.target = "_blank";
      }
    } else if (isSafeExternalReference(reference)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } else {
      anchor.removeAttribute("href");
    }
  });

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

async function renderHtmlDocument(opened: OpenedDocument): Promise<void> {
  const { files, warnings } = await loadHtmlDependencies(opened);
  const preview = document.createElement("iframe");
  preview.className = "html-preview";
  preview.title = opened.name;
  preview.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  preview.setAttribute("referrerpolicy", "no-referrer");
  preview.srcdoc = transformHtml(opened.entryPath, opened.content, files);
  viewerBody.replaceChildren(preview);
  activeHtmlPreview = preview;
  schedulePreviewResize();
  if (warnings.length) {
    showMessage(`一部の関連ファイルを読み込めませんでした: ${warnings.slice(0, 3).join(" / ")}`, "warning");
  } else {
    showMessage();
  }
}

async function renderMarkdown(opened: OpenedDocument): Promise<void> {
  marked.setOptions({ breaks: true, gfm: true });
  const container = document.createElement("article");
  container.className = "markdown-body";
  container.innerHTML = DOMPurify.sanitize(marked.parse(opened.content));

  const localImages = new Map<string, HTMLImageElement[]>();
  container.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const reference = image.getAttribute("src") || "";
    const resolved = resolvePackagePath(opened.entryPath, reference);
    if (!resolved) return;
    const images = localImages.get(resolved) || [];
    images.push(image);
    localImages.set(resolved, images);
  });
  if (opened.packageRootId && localImages.size) {
    const paths = [...localImages.keys()].slice(0, MAX_PACKAGE_FILES);
    for (let index = 0; index < paths.length; index += PACKAGE_BATCH_SIZE) {
      const results = await gasRun<PackageFileResult[]>(
        "getPackageFiles",
        opened.packageRootId,
        paths.slice(index, index + PACKAGE_BATCH_SIZE),
      );
      for (const result of results) {
        if (!result.ok || !result.file) continue;
        for (const image of localImages.get(result.path) || []) image.src = fileDataUrl(result.file);
      }
    }
  }

  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    if (/^https:/i.test(href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
  });
  container.querySelectorAll("pre > code.language-mermaid").forEach((code) => {
    const diagram = document.createElement("div");
    diagram.className = "mermaid";
    diagram.textContent = code.textContent || "";
    code.parentElement?.replaceWith(diagram);
  });
  container.querySelectorAll("pre code").forEach((block) => hljs.highlightElement(block));
  viewerBody.replaceChildren(container);
  if (container.querySelector(".mermaid")) showMessage("Mermaidを描画しています…", "loading");
  const mermaidOk = await renderMermaidBlocks(container);
  if (mermaidOk) showMessage();
  else showMessage("一部のMermaid図を描画できませんでした。図中のエラーを確認してください。", "warning");
}

syncThemeControls(darkModeEnabled());

const initial = window.__INITIAL_REQUEST__;
if (initial?.id) {
  urlInput.value = initial.id;
  void openDocument({ id: initial.id, resourceKey: initial.resourceKey });
} else {
  urlInput.focus();
}
