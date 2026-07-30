import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ContextDocumentSource, ExtractedDocument } from "@/types";

// Bundle the worker locally. Pluely must keep working offline, so no CDN.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md"];

const sourceTypeFor = (fileName: string): ContextDocumentSource | null => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".txt")) return "text";
  return null;
};

async function extractPdfText(file: File): Promise<string> {
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

  const raw =
    sourceType === "pdf" ? await extractPdfText(file) : await file.text();
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
