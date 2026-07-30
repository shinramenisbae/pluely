export type ContextDocumentSource = "pdf" | "text" | "markdown";

export interface ContextDocument {
  id: number;
  name: string;
  content: string;
  source_type: ContextDocumentSource;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ContextDocumentInput {
  name: string;
  content: string;
  source_type: ContextDocumentSource;
}

export interface ExtractedDocument {
  name: string;
  content: string;
  sourceType: ContextDocumentSource;
}
