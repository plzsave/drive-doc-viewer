export type DocumentKind = "markdown" | "html";

export interface OpenDocumentRequest {
  input?: string;
  id?: string;
  resourceKey?: string;
}

export interface OpenedDocument {
  id: string;
  name: string;
  kind: DocumentKind;
  mimeType: string;
  content: string;
  lastUpdated: number;
  packageRootId: string;
  entryPath: string;
  appUrl: string;
}

export interface PackageFile {
  path: string;
  mimeType: string;
  encoding: "text" | "base64";
  content: string;
  size: number;
}

export interface PackageFileResult {
  path: string;
  ok: boolean;
  file?: PackageFile;
  error?: string;
}

export interface InitialRequest {
  id: string;
  resourceKey: string;
}
