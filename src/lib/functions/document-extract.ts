import { invoke } from "@tauri-apps/api/core";
import type { ContextDocumentSource, ExtractedDocument } from "@/types";

export const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md"];

const sourceTypeFor = (fileName: string): ContextDocumentSource | null => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".txt")) return "text";
  return null;
};

/**
 * PDF text extraction runs in Rust (see src-tauri/src/documents.rs).
 * pdf.js needs a web worker, and loading one over Tauri's asset protocol fails
 * in WKWebView with an unactionable minified error.
 */
async function extractPdfText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return invoke<string>("extract_pdf_text", {
    data: Array.from(new Uint8Array(buffer)),
  });
}

/**
 * Extract plain text from a resume or note file.
 * Throws with an actionable message rather than returning empty content, so a
 * failed extraction is visible at import time instead of mid-interview.
 */
export async function extractDocumentText(
  file: File
): Promise<ExtractedDocument> {
  const sourceType = sourceTypeFor(file.name);

  if (!sourceType) {
    throw new Error(
      `Unsupported file type. Supported formats: ${SUPPORTED_EXTENSIONS.join(
        ", "
      )}`
    );
  }

  let raw: string;
  try {
    raw = sourceType === "pdf" ? await extractPdfText(file) : await file.text();
  } catch (err) {
    console.error("Document extraction failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${file.name}: ${detail}`);
  }

  const content = raw
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!content) {
    throw new Error(
      sourceType === "pdf"
        ? "No text found — this PDF appears to be scanned. OCR is not supported, so export it as a text-based PDF or paste the text instead."
        : "This file is empty."
    );
  }

  return { name: file.name, content, sourceType };
}
