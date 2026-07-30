# Personal Context documents

Date: 2026-07-31
Status: approved, ready to implement

## Problem

During an interview, Pluely transcribes the interviewer's question and generates an
answer, but it knows nothing about the user's background. Answers are generic
because the model has never seen the resume.

The resume is a PDF, and Pluely cannot read PDFs at all: both file pickers hardcode
`accept="image/*"` (`src/pages/app/components/completion/Files.tsx`,
`src/pages/chats/components/ChatFiles.tsx`), and the string "pdf" appears nowhere in
the source. Attached files are base64-encoded and sent as images.

A user can paste resume text into a custom system prompt today and it will be
injected. That workaround fails for three reasons:

1. It requires manually converting the PDF to text.
2. A system prompt holds *instructions*; mixing in biographical facts conflates two
   concerns.
3. Selecting any other system prompt silently drops the resume mid-interview.

## Goal

Drop a resume into the UI, have its text extracted and stored, and have every
request carry it as context — so when a transcript or typed prompt contains a
question about the user's history, the model answers from the resume.

## Non-goals

Embeddings, vector search, retrieval ranking, folder watching, and multi-document
management are all out of scope. Those belong to the larger knowledge-base work
("direction C"), which is deferred. This feature builds the ingestion and storage
layer that work will reuse.

OCR for scanned, image-only PDFs is out of scope. Such files must fail with a clear
message rather than silently storing an empty document.

## Design

### Data flow

```
resume.pdf --[pdf.js text layer]--> extracted text --> context_documents (SQLite)
                                                              |
                                            active doc cached in localStorage
                                                              |
                                                              v
                             buildEnhancedSystemPrompt() --> every AI request
```

### Storage

Mirrors the existing system-prompts pattern exactly: SQLite is the durable library,
localStorage caches the active value so it can be read synchronously.

New table via migration version 3, `src-tauri/src/db/migrations/context-documents.sql`,
registered in `src-tauri/src/db/main.rs`:

```sql
CREATE TABLE IF NOT EXISTS context_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT NOT NULL,      -- 'pdf' | 'text' | 'markdown'
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')) NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);
```

Two new storage keys: `personal_context_content` (extracted text of the active
document) and `personal_context_enabled` (`"true"`/`"false"`).

### Text extraction

`src/lib/functions/document-extract.ts` exposes
`extractDocumentText(file: File): Promise<ExtractedDocument>`.

- `.pdf` — `pdfjs-dist`, concatenating the text layer across pages. The worker is
  bundled locally; no network access, no CDN (the app must keep working offline).
- `.txt` / `.md` — read directly as UTF-8.
- Any other type — throw with a message naming the supported formats.
- A PDF that yields only whitespace throws "No text found — this PDF appears to be
  scanned. OCR is not supported." This is the scanned-PDF case, and it must be loud.

### Injection

`buildEnhancedSystemPrompt()` in `src/lib/functions/ai-response.function.ts` is the
single point every request already passes through. It gains one block, appended
after the base system prompt and before formatting instructions:

```
<personal_context>
The following is the user's own background. When the user is asked a question
about their experience, history, or qualifications, answer using these facts.
Do not invent details that are not present here.

{content}
</personal_context>
```

Skipped entirely when no document is active or the toggle is off, leaving current
behaviour byte-identical.

Delimiters matter: the resume is untrusted-ish text sharing a prompt with
instructions, and a clear boundary keeps the model from reading resume content as
directives.

The function stays synchronous by reading the localStorage cache, matching how the
active system prompt is already handled (`app.context.tsx` seeds `systemPrompt` from
`STORAGE_KEYS.SYSTEM_PROMPT`).

### UI

A "Personal Context" section on the Dev space page, beside AI and STT providers:

- Import control accepting `.pdf`, `.txt`, `.md`.
- After import: document name, source type, character count, and a preview of the
  extracted text so extraction failures are visible immediately rather than at
  interview time.
- An enable/disable toggle — on for interviews, off for client calls.
- A remove action.

Extraction errors surface inline, in full.

## Testing

Extraction is where this breaks, so that is where the tests go:

1. A text-layer PDF returns its text.
2. A scanned/image-only PDF throws the scanned-PDF error rather than returning "".
3. `.md` and `.txt` pass through unchanged.
4. An unsupported type throws naming supported formats.
5. `buildEnhancedSystemPrompt()` includes the block when a document is active and
   enabled, and is unchanged when absent or disabled.

Manual end-to-end: import a real resume, ask "what's my background?", confirm the
answer uses resume facts; disable the toggle and confirm it no longer does.

## Consequences

Resume text is sent to whichever model backend is configured, on every request.
That is inherent to the feature, but worth stating: the choice of backend
determines where this personal data goes.

Token cost is roughly 1–2k per request for a typical resume, mitigated by prompt
caching on providers that support it.
