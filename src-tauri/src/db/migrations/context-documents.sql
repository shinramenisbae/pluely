-- Create context_documents table
CREATE TABLE IF NOT EXISTS context_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')) NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Index for faster lookups by name
CREATE INDEX IF NOT EXISTS idx_context_documents_name ON context_documents(name);

-- Trigger to automatically update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_context_documents_timestamp
AFTER UPDATE ON context_documents
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE context_documents
    SET updated_at = datetime('now')
    WHERE id = NEW.id;
END;
