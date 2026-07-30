import { getDatabase } from "./config";
import type { ContextDocument, ContextDocumentInput } from "@/types";

/**
 * Replace the stored personal context document.
 * Only one document is supported today; the knowledge-base work will lift this.
 */
export async function saveContextDocument(
  input: ContextDocumentInput
): Promise<ContextDocument> {
  const db = await getDatabase();

  const name = input.name.trim();
  const content = input.content.trim();

  if (!name) {
    throw new Error("Document name cannot be empty");
  }
  if (!content) {
    throw new Error("Document content cannot be empty");
  }

  await db.execute("DELETE FROM context_documents");

  const result = await db.execute(
    "INSERT INTO context_documents (name, content, source_type) VALUES (?, ?, ?)",
    [name, content, input.source_type]
  );

  const inserted = await db.select<ContextDocument[]>(
    "SELECT * FROM context_documents WHERE id = ?",
    [result.lastInsertId]
  );

  if (!inserted[0]) {
    throw new Error("Failed to retrieve saved context document");
  }

  return inserted[0];
}

export async function getContextDocument(): Promise<ContextDocument | null> {
  const db = await getDatabase();
  const rows = await db.select<ContextDocument[]>(
    "SELECT * FROM context_documents ORDER BY id DESC LIMIT 1"
  );
  return rows[0] ?? null;
}

export async function deleteContextDocument(): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM context_documents");
}

export async function setContextDocumentEnabled(
  enabled: boolean
): Promise<void> {
  const db = await getDatabase();
  await db.execute("UPDATE context_documents SET enabled = ?", [enabled ? 1 : 0]);
}
