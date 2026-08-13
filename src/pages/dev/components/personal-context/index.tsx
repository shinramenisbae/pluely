import { useEffect, useRef, useState } from "react";
import { Button, Card, Header, Switch } from "@/components";
import { FileTextIcon, Trash2Icon, UploadIcon } from "lucide-react";
import {
  deleteContextDocument,
  extractDocumentText,
  getContextDocument,
  isPersonalContextEnabled,
  saveContextDocument,
  setContextDocumentEnabled,
  setPersonalContext,
  setPersonalContextEnabled,
  clearPersonalContext,
  SUPPORTED_EXTENSIONS,
} from "@/lib";
import type { ContextDocument } from "@/types";

export const PersonalContext = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [document, setDocument] = useState<ContextDocument | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getContextDocument()
      .then((doc) => {
        setDocument(doc);
        setEnabled(isPersonalContextEnabled());
        // Keep the synchronous cache in step with the database.
        if (doc) setPersonalContext(doc.content);
        else clearPersonalContext();
      })
      .catch((err) => setError(`Failed to load: ${err}`));
  }, []);

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError("");
    setIsImporting(true);
    try {
      const extracted = await extractDocumentText(file);
      const saved = await saveContextDocument({
        name: extracted.name,
        content: extracted.content,
        source_type: extracted.sourceType,
      });
      setPersonalContext(saved.content);
      setPersonalContextEnabled(true);
      setEnabled(true);
      setDocument(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  };

  const handleRemove = async () => {
    setError("");
    try {
      await deleteContextDocument();
      clearPersonalContext();
      setDocument(null);
    } catch (err) {
      setError(`Failed to remove: ${err}`);
    }
  };

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setPersonalContextEnabled(next);
    try {
      await setContextDocumentEnabled(next);
    } catch (err) {
      setError(`Failed to update: ${err}`);
    }
  };

  return (
    <div id="personal-context" className="space-y-3">
      <Header
        title="Personal Context"
        description="Attach your resume so answers draw on your real background. Used for every response while enabled."
        isMainTitle
      />

      <Card className="p-4 space-y-3 shadow-none border border-input/50">
        {document ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <FileTextIcon className="size-5 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {document.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {document.source_type} ·{" "}
                    {document.content.length.toLocaleString()} characters
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch checked={enabled} onCheckedChange={handleToggle} />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleRemove}
                  title="Remove document"
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="rounded-lg bg-black/5 dark:bg-white/5 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Extracted text preview
              </p>
              <p className="text-xs text-muted-foreground line-clamp-4 whitespace-pre-wrap">
                {document.content.slice(0, 500)}
              </p>
            </div>

            {!enabled && (
              <p className="text-xs text-muted-foreground">
                Disabled — responses will not use this document.
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <UploadIcon className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No document attached</p>
            <p className="text-xs text-muted-foreground">
              Supported formats: {SUPPORTED_EXTENSIONS.join(", ")}
            </p>
          </div>
        )}

        <Button
          className="w-full"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
        >
          {isImporting
            ? "Extracting..."
            : document
            ? "Replace document"
            : "Attach document"}
        </Button>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </Card>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.md"
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
};
