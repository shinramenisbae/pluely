import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";

/**
 * Cached copy of the active personal context document.
 *
 * SQLite is the durable store, but buildEnhancedSystemPrompt() runs synchronously
 * on every request, so the active text is mirrored here — the same split the
 * active system prompt already uses.
 */
export const getPersonalContext = (): string => {
  const enabled = safeLocalStorage.getItem(STORAGE_KEYS.PERSONAL_CONTEXT_ENABLED);
  if (enabled === "false") {
    return "";
  }
  return safeLocalStorage.getItem(STORAGE_KEYS.PERSONAL_CONTEXT_CONTENT) || "";
};

export const setPersonalContext = (content: string): void => {
  safeLocalStorage.setItem(STORAGE_KEYS.PERSONAL_CONTEXT_CONTENT, content);
};

export const clearPersonalContext = (): void => {
  safeLocalStorage.removeItem(STORAGE_KEYS.PERSONAL_CONTEXT_CONTENT);
};

export const isPersonalContextEnabled = (): boolean =>
  safeLocalStorage.getItem(STORAGE_KEYS.PERSONAL_CONTEXT_ENABLED) !== "false";

export const setPersonalContextEnabled = (enabled: boolean): void => {
  safeLocalStorage.setItem(
    STORAGE_KEYS.PERSONAL_CONTEXT_ENABLED,
    enabled ? "true" : "false"
  );
};
