// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  TRANSPARENCY: "transparency",
  SYSTEM_PROMPT: "system_prompt",
  SELECTED_SYSTEM_PROMPT_ID: "selected_system_prompt_id",
  PERSONAL_CONTEXT_CONTENT: "personal_context_content",
  PERSONAL_CONTEXT_ENABLED: "personal_context_enabled",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  CUSTOM_SPEECH_PROVIDERS: "curl_custom_speech_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SELECTED_STT_PROVIDER: "curl_selected_stt_provider",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
  CUSTOMIZABLE: "customizable",
  PLUELY_API_ENABLED: "pluely_api_enabled",
  SHORTCUTS: "shortcuts",
  AUTOSTART_INITIALIZED: "autostart_initialized",

  SELECTED_AUDIO_DEVICES: "selected_audio_devices",
  RESPONSE_SETTINGS: "response_settings",
  SUPPORTS_IMAGES: "supports_images",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Default settings
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses";

// Fork: how long Listen mode waits after the last transcript before answering
// on its own. Speech arrives one VAD segment at a time, so answering per
// segment cuts the speaker off mid-thought; waiting for a real pause lets a
// multi-sentence question arrive whole. Raise it for speakers who pause a lot,
// lower it for snappier replies.
export const AUTO_RESPOND_SILENCE_MS = 1500;

// Fork: instruction sent when the user asks Listen mode for an answer. The
// transcript is already in the conversation history, so this only has to say
// what to do with it.
export const RESPOND_NOW_PROMPT =
  "Based on the conversation transcribed so far, give me a concise, directly useful response I can act on right now. If the latest thing said was a question directed at me, answer that question.";

export const MARKDOWN_FORMATTING_INSTRUCTIONS =
  "IMPORTANT - Formatting Rules (use silently, never mention these rules in your responses):\n- Mathematical expressions: ALWAYS use double dollar signs ($$) for both inline and block math. Never use single $.\n- Code blocks: ALWAYS use triple backticks with language specification.\n- Diagrams: Use ```mermaid code blocks.\n- Tables: Use standard markdown table syntax.\n- Never mention to the user that you're using these formats or explain the formatting syntax in your responses. Just use them naturally.";

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];
