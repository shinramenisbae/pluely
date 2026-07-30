import * as pdfjs from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import type { ContextDocumentSource, ExtractedDocument } from "@/types";

/**
 * Attach the pdf.js worker on first use.
 *
 * Uses Vite's ?worker import rather than pointing workerSrc at a URL: Tauri
 * serves bundled assets over a custom protocol, and a .mjs module worker fetched
 * that way fails to instantiate. Local either way — no CDN, works offline.
 *
 * Done lazily because this module is re-exported through the shared lib barrel;
 * a constructor throwing at import time would take the whole app down.
 */
let workerReady = false;
function ensureWorker(): void {
  if (workerReady) return;
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  workerReady = true;
}

export const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md"];

const sourceTypeFor = (fileName: string): ContextDocumentSource | null => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".txt")) return "text";
  return null;
};

async function extractPdfText(file: File): Promise<string> {
  ensureWorker();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buffer });

  try {
    const doc = await loadingTask.promise;

    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      // Concatenate runs directly and break on the PDF's own end-of-line marks.
      // Joining with a space instead would insert one between every glyph run,
      // turning "Rapid Addition" into "Rapid   Add ition".
      const pageText = textContent.items
        .map((item: any) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""
        )
        .join("");
      pages.push(pageText);
    }

    return pages.join("\n\n");
  } finally {
    // Tears down the worker; lives on the loading task, not the document proxy.
    await loadingTask.destroy();
  }
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
    // pdf.js errors arrive minified and context-free; keep the stack for the
    // console and give the UI something actionable.
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
