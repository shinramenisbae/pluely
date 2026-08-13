import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import {
  AUTO_RESPOND_SILENCE_MS,
  DEFAULT_CONTEXT_WINDOW_MINUTES,
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  RESPOND_NOW_PROMPT,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  shouldUsePluelyAPI,
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
} from "@/lib";
import { Message } from "@/types/completion";

// VAD Configuration interface matching Rust
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
  // Fork: how long Listen mode waits after the last transcript before
  // answering on its own. Frontend-only - the Rust VadConfig does not declare
  // it and serde ignores unknown fields, so it rides along harmlessly.
  auto_respond_silence_ms: number;
  // Fork: how much of the transcript to send with an answer, in minutes.
  // 0 means the whole conversation. Also frontend-only.
  context_window_minutes: number;
}

// OPTIMIZED VAD defaults - matches backend exactly for perfect performance
const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012, // Much less sensitive - only real speech
  peak_threshold: 0.035, // Higher threshold - filters clicks/noise
  silence_chunks: 45, // ~1.0s of required silence
  min_speech_chunks: 7, // ~0.16s - captures short answers
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.003, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
  auto_respond_silence_ms: AUTO_RESPOND_SILENCE_MS,
  context_window_minutes: DEFAULT_CONTEXT_WINDOW_MINUTES,
};

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  // Fork: set on turns the user deliberately typed, and on the answers to
  // them. The auto-answer context window trims by age, which is right for
  // speech - a transcript line from twenty minutes ago is usually noise - but
  // wrong for these: a briefing ("this is a backend interview, keep answers
  // short") does not stop applying because it got old. Pinned messages are
  // exempt from the window and always sent.
  pinned?: boolean;
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  // Fork: guards against overlapping manual triggers (see runPrompt). A ref,
  // not state, so a repeated keypress sees the current value immediately.
  const isRespondingRef = useRef(false);
  // Fork: auto-answer scheduling. Each transcript pushes the timer back, so the
  // model runs once the speaker actually stops rather than once per segment.
  // pendingAutoRespondRef records a pause that landed while an answer was
  // already streaming - that answer is never aborted, the next one runs after.
  const autoRespondTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingAutoRespondRef = useRef(false);
  const autoRespondDelayRef = useRef(AUTO_RESPOND_SILENCE_MS);
  // Fork: speech is being captured or transcribed right now, so the newest
  // utterance is not in the conversation yet. Used to defer a manual answer
  // until it lands rather than answering without it.
  const speechInFlightRef = useRef(false);
  const sttInFlightRef = useRef(false);
  const pendingManualRespondRef = useRef(false);
  // Mirrors `capturing` for callbacks that must stay stable (updateVadConfiguration
  // is passed to the settings panel; re-creating it on every capture toggle
  // would churn the panel's handlers).
  const capturingRef = useRef(false);
  // Declared here rather than beside requestResponse: the speech listener is
  // defined earlier in this hook and reaches it through the ref.
  const requestResponseRef = useRef<() => void>(() => {});
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Fork: (re)arm the auto-answer timer. Called on every transcript, so a
  // speaker who keeps going keeps pushing the answer back. Stable identity -
  // it only touches refs - so the speech listener never re-registers for it.
  const scheduleAutoResponse = useCallback(() => {
    if (autoRespondTimerRef.current) {
      clearTimeout(autoRespondTimerRef.current);
    }
    // Read through a ref: this callback must keep a stable identity (the
    // speech listener depends on it), so it cannot close over vadConfig.
    const delay = autoRespondDelayRef.current;
    // Fork: 0 means "never answer on its own". Transcripts still accumulate,
    // and Respond now (or Ctrl+Shift+Enter) answers against all of them - the
    // whole conversation is sent as history, so speech split across several
    // segments is still answered as one question.
    if (delay <= 0) {
      return;
    }
    autoRespondTimerRef.current = setTimeout(() => {
      autoRespondTimerRef.current = null;
      if (isRespondingRef.current) {
        // An answer is still streaming. Don't abort it - queue instead, and
        // processWithAI will pick this up when it finishes.
        pendingAutoRespondRef.current = true;
        return;
      }
      requestResponseRef.current();
    }, delay);
  }, []);

  const cancelAutoResponse = useCallback(() => {
    if (autoRespondTimerRef.current) {
      clearTimeout(autoRespondTimerRef.current);
      autoRespondTimerRef.current = null;
    }
    pendingAutoRespondRef.current = false;
    pendingManualRespondRef.current = false;
  }, []);

  // Keep the delay the scheduler reads in step with the setting. A timer
  // already armed keeps its original delay; the next one uses the new value.
  useEffect(() => {
    autoRespondDelayRef.current =
      vadConfig.auto_respond_silence_ms ?? AUTO_RESPOND_SILENCE_MS;
  }, [vadConfig.auto_respond_silence_ms]);

  // Load context settings and VAD config from localStorage on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    // Load VAD config
    const savedVadConfig = safeLocalStorage.getItem("vad_config");
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig);
        // Fork: merge over the defaults rather than replacing them. A config
        // saved before a field existed would otherwise load it as undefined -
        // for auto_respond_silence_ms that means a zero-delay timer, i.e. the
        // per-segment answering this setting exists to prevent.
        setVadConfig({ ...DEFAULT_VAD_CONFIG, ...parsed });
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }
  }, []);

  // Load quick actions from localStorage on mount
  useEffect(() => {
    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;
    let speechStartUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Fork: speech has started but the segment has not closed yet. The VAD
        // only closes it after a full Silence Duration of quiet, and STT runs
        // after that - so for several seconds after the speaker stops, what
        // they just said is not in the conversation yet. Respond now pressed in
        // that gap used to answer without it, which read as answering the
        // previous question and needing a second press.
        speechStartUnlisten = await listen("speech-start", () => {
          speechInFlightRef.current = true;
        });

        // Speech discarded (too short)
        discardedUnlisten = await listen("speech-discarded", (event) => {
          const reason = event.payload as string;
          console.log("Speech discarded:", reason);
          // Nothing will be transcribed, so a waiting request must not hang.
          speechInFlightRef.current = false;
          if (pendingManualRespondRef.current) {
            pendingManualRespondRef.current = false;
            requestResponseRef.current();
          }
          // Don't show error - this is expected behavior
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
      if (speechStartUnlisten) speechStartUnlisten();
    };
  }, []);

  // Handle single speech detection event (both VAD and continuous modes)
  useEffect(() => {
    let speechUnlisten: (() => void) | undefined;
    // Fork: listen() is async, so a fast dependency change can run the cleanup
    // before it resolves - leaving speechUnlisten undefined and the listener
    // permanently attached. This flag makes the cleanup win that race.
    let cancelled = false;

    const setupEventListener = async () => {
      try {
        const unlisten = await listen("speech-detected", async (event) => {
          try {
            if (!capturing) return;

            const base64Audio = event.payload as string;
            // Convert to blob
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const audioBlob = new Blob([bytes], { type: "audio/wav" });

            const usePluelyAPI = await shouldUsePluelyAPI();
            if (!selectedSttProvider.provider && !usePluelyAPI) {
              setError("No speech provider selected.");
              return;
            }

            const providerConfig = allSttProviders.find(
              (p) => p.id === selectedSttProvider.provider
            );

            if (!providerConfig && !usePluelyAPI) {
              setError("Speech provider config not found.");
              return;
            }

            setIsProcessing(true);
            sttInFlightRef.current = true;

            // Add timeout wrapper for STT request (30 seconds)
            const sttPromise = fetchSTT({
              provider: providerConfig,
              selectedProvider: selectedSttProvider,
              audio: audioBlob,
            });

            const timeoutPromise = new Promise<string>((_, reject) => {
              setTimeout(
                () => reject(new Error("Speech transcription timed out (30s)")),
                30000
              );
            });

            try {
              const transcription = await Promise.race([
                sttPromise,
                timeoutPromise,
              ]);

              if (transcription.trim()) {
                setLastTranscription(transcription);
                setError("");

                // Fork: transcripts accumulate into the conversation instead of
                // triggering a response. Previously every VAD segment fired an
                // LLM call that aborted the one before it, so a speaker pausing
                // mid-sentence produced a stream of cancelled half-answers.
                // The model now runs only on the respond_now shortcut, and gets
                // the whole conversation rather than one fragment.
                const timestamp = Date.now();
                setConversation((prev) => ({
                  ...prev,
                  messages: [
                    {
                      id: generateMessageId("user", timestamp),
                      role: "user" as const,
                      content: transcription,
                      timestamp,
                    },
                    ...prev.messages,
                  ],
                  updatedAt: timestamp,
                  title:
                    prev.title || generateConversationTitle(transcription),
                }));

                // Fork: answer once the speaker pauses. Re-armed per segment,
                // so a multi-sentence question is answered as one question.
                scheduleAutoResponse();

                // Fork: a manual answer was requested while this utterance was
                // still being captured or transcribed. It is in the
                // conversation now, so run the answer the user actually asked
                // for - the one that includes what was just said.
                if (pendingManualRespondRef.current) {
                  pendingManualRespondRef.current = false;
                  cancelAutoResponse();
                  requestResponseRef.current();
                }
              } else {
                setError("Received empty transcription");
              }
            } catch (sttError: any) {
              console.error("STT Error:", sttError);
              setError(sttError.message || "Failed to transcribe audio");
              setIsPopoverOpen(true);
            }
          } catch (err) {
            setError("Failed to process speech");
          } finally {
            setIsProcessing(false);
            sttInFlightRef.current = false;
            speechInFlightRef.current = false;
            // Transcription failed or produced nothing, so the release above
            // never ran. Don't leave a requested answer waiting forever.
            if (pendingManualRespondRef.current) {
              pendingManualRespondRef.current = false;
              requestResponseRef.current();
            }
          }
        });

        if (cancelled) {
          unlisten();
          return;
        }
        speechUnlisten = unlisten;
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };

    setupEventListener();

    return () => {
      cancelled = true;
      if (speechUnlisten) speechUnlisten();
    };
    // Fork: conversation.messages.length was a dependency here, which turned
    // every appended transcript into a listener re-registration. Combined with
    // the race above, listeners accumulated and each one issued its own STT
    // request for the same audio - producing duplicate transcripts and hammering
    // the STT provider's rate limit. The handler only writes via the
    // setConversation updater, so it never needed to read the conversation.
  }, [capturing, selectedSttProvider, allSttProviders, scheduleAutoResponse]);

  // Context management functions
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        const contextSettings = {
          useSystemPrompt: usePrompt,
          contextContent: content,
        };
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify(contextSettings)
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  // Fork: single path for every manual trigger - quick actions and the
  // respond_now shortcut. Defined below processWithAI, which it depends on.

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Fork: the Rust side refuses to start while a capture task is still
      // registered ("Capture already running"), and a session that ended by
      // any path other than ignoreContinuousRecording - a prior VAD session,
      // an aborted send, a reload mid-recording - leaves one behind. The VAD
      // path in startCapture already clears it first; manual start did not,
      // so it failed until the app was restarted. stop is idempotent.
      await invoke<string>("stop_system_audio_capture");

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  // Ignore current recording (stop without transcription)
  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // AI Processing function
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[],
      // Fork: manual triggers pass an instruction, not speech. Persisting it
      // would title the conversation with the instruction and feed it back as
      // context on every later call, so those callers opt out.
      persistUserMessage: boolean = true,
      // Fork: mark this exchange exempt from the auto-answer context window.
      // Set for typed turns, which stay relevant however old they get.
      pinned: boolean = false
    ) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Fork: keep a local handle. abortControllerRef is overwritten by any
      // later call, so this is the only reliable way for this invocation to
      // tell whether it was superseded.
      const controller = new AbortController();
      abortControllerRef.current = controller;
      isRespondingRef.current = true;

      try {
        setIsAIProcessing(true);
        setLastAIResponse("");
        setError("");

        let fullResponse = "";

        const usePluelyAPI = await shouldUsePluelyAPI();
        if (!selectedAIProvider.provider && !usePluelyAPI) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !usePluelyAPI) {
          setError("AI provider config not found.");
          return;
        }

        try {
          for await (const chunk of fetchAIResponse({
            provider: usePluelyAPI ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: prompt,
            history: previousMessages,
            userMessage: transcription,
            imagesBase64: [],
            // Fork: the signal was built and aborted but never passed, so the
            // abort above did nothing - every overlapping request ran to
            // completion and wrote its own answer.
            signal: controller.signal,
          })) {
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          setError(aiError.message || "Failed to get AI response");
        }

        // Fork: a superseded request must not persist its partial answer.
        if (fullResponse && !controller.signal.aborted) {
          const timestamp = Date.now();
          const assistantMessage = {
            id: generateMessageId("assistant", timestamp + 1),
            role: "assistant" as const,
            content: fullResponse,
            timestamp: timestamp + 1,
            // The reply to a pinned turn is pinned too - keeping the briefing
            // but dropping the acknowledgement of it would leave a dangling
            // half-exchange in the history.
            ...(pinned ? { pinned: true } : {}),
          };
          const newMessages = persistUserMessage
            ? [
                {
                  id: generateMessageId("user", timestamp),
                  role: "user" as const,
                  content: transcription,
                  timestamp,
                  ...(pinned ? { pinned: true } : {}),
                },
                assistantMessage,
              ]
            : [assistantMessage];

          setConversation((prev) => ({
            ...prev,
            messages: [...newMessages, ...prev.messages],
            updatedAt: timestamp,
            title: persistUserMessage
              ? prev.title || generateConversationTitle(transcription)
              : prev.title,
          }));
        }
      } catch (err) {
        setError("Failed to get AI response");
      } finally {
        setIsAIProcessing(false);
        isRespondingRef.current = false;
        // Fork: speech that arrived while this answer was streaming queued a
        // follow-up rather than cancelling it. Run it now, against the fuller
        // transcript. Re-arming the timer (rather than firing immediately)
        // keeps the same pause rule if the speaker is still talking.
        if (pendingAutoRespondRef.current) {
          pendingAutoRespondRef.current = false;
          scheduleAutoResponse();
        }
      }
    },
    [
      selectedAIProvider,
      allAiProviders,
      conversation.messages,
      scheduleAutoResponse,
    ]
  );

  // Fork: single path for every manual trigger - quick actions and the
  // respond_now shortcut. Transcripts already land in the conversation as they
  // arrive, so this only has to replay them with the requested instruction.
  const runPrompt = useCallback(
    async (
      prompt: string,
      options: {
        fullTranscript?: boolean;
        persist?: boolean;
        pinned?: boolean;
      } = {}
    ) => {
      const {
        fullTranscript = false,
        persist = false,
        pinned = false,
      } = options;
      // Fork: a global shortcut repeats while held, and each repeat used to
      // start another answer. One request at a time - later triggers are
      // ignored until the current one finishes rather than stacking.
      if (isRespondingRef.current) {
        return;
      }
      setError("");

      const effectiveSystemPrompt = useSystemPrompt
        ? systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;

      // Fork: bound the transcript sent to the model. Listen mode can run for
      // an hour, and replaying all of it on every answer is expensive, slow,
      // and actively worse - the answer wanted is to what was just said, and
      // it ends up buried under everything before it. Keep only the last
      // context_window_minutes; 0 means no limit.
      //
      // A typed question is the exception and passes useFullTranscript. It is
      // deliberate and can refer to anything ("what did she ask at the
      // start?"), so windowing it would break exactly what it is for. It is
      // also user-initiated and therefore rare, so the cost is bounded.
      const windowMinutes = fullTranscript
        ? 0
        : vadConfig.context_window_minutes ?? DEFAULT_CONTEXT_WINDOW_MINUTES;
      const cutoff =
        windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : 0;

      // conversation.messages is stored newest-first, but buildDynamicMessages
      // splices history into the request as-is - without this reverse the model
      // reads the conversation backwards.
      // Pinned turns survive the window: what makes a message worth keeping is
      // what kind it is, not how old. Trimming a briefing by age would leave
      // the model agreeing to instructions it can no longer see.
      const previousMessages = [...conversation.messages]
        .filter((msg) => msg.pinned || msg.timestamp >= cutoff)
        .reverse()
        .map((msg) => ({ role: msg.role, content: msg.content }));

      await processWithAI(
        prompt,
        effectiveSystemPrompt,
        previousMessages,
        persist,
        pinned
      );
    },
    [
      vadConfig.context_window_minutes,
      useSystemPrompt,
      systemPrompt,
      contextContent,
      conversation.messages,
      processWithAI,
    ]
  );

  const handleQuickActionClick = async (action: string) => {
    await runPrompt(action);
  };

  // Fork: a question the user typed. Two things set it apart from the presets
  // and respond_now, which mean "answer what was just said":
  //
  // fullTranscript - it can refer to any point in the call, so windowing it
  // would break what it is for.
  //
  // persist - it is a real user turn and is kept in the conversation. The
  // synthetic instructions are not, since "Respond now" as a transcript line
  // would be noise. This matters most before an interview starts: briefing the
  // model ("this is a backend role, focus on system design") is only useful if
  // the briefing is still there on later turns, not just the reply to it.
  const askAboutTranscript = useCallback(
    (question: string) =>
      runPrompt(question, {
        fullTranscript: true,
        persist: true,
        pinned: true,
      }),
    [runPrompt]
  );

  // Fork: answer on demand using everything transcribed so far.
  //
  // If speech is still being captured or transcribed, wait for it. The VAD
  // holds a segment open for a full Silence Duration after the speaker stops,
  // and STT runs after that, so for several seconds the newest utterance is
  // not in the conversation. Answering immediately would answer the previous
  // question - which is what made a single press look like it was one behind.
  const requestResponse = useCallback(() => {
    if (speechInFlightRef.current || sttInFlightRef.current) {
      pendingManualRespondRef.current = true;
      return;
    }
    return runPrompt(RESPOND_NOW_PROMPT);
  }, [runPrompt]);

  const startCapture = useCallback(async () => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;

      // Set up conversation
      const conversationId = generateConversationId("sysaudio");
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(isContinuous);
      setRecordingProgress(0);

      // If continuous mode
      if (isContinuous) {
        setIsRecordingInContinuousMode(false);
        return;
      }

      // VAD mode: Start recording immediately
      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start capture with VAD config
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // Fork: drop any armed or queued auto-answer - the user has stopped
      // listening, so a pending timer must not fire a request afterwards.
      cancelAutoResponse();

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
      setIsPopoverOpen(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    }
  }, [cancelAutoResponse]);

  // Manual stop for continuous recording
  const manualStopAndSend = useCallback(async () => {
    try {
      if (!isContinuousMode) {
        console.warn("Not in continuous mode");
        return;
      }

      // Show processing state immediately
      setIsProcessing(true);

      // Trigger manual stop event
      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false); // Clear processing state on error
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  useEffect(() => {
    const shouldOpenPopover =
      capturing ||
      setupRequired ||
      isAIProcessing ||
      !!lastAIResponse ||
      !!error;
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    capturing,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    error,
    resizeWindow,
  ]);

  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturing) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [startCapture, stopCapture]);

  // Fork: respond_now is dispatched by the Rust custom_action branch, so it
  // needs no native handler - only a callback registered against its id.
  // requestResponse changes identity on every new message, so it is held in a
  // ref and the callback registered once - re-registering per message would
  // repeat the churn that broke the speech listener.
  useEffect(() => {
    requestResponseRef.current = () => {
      void requestResponse();
    };
  }, [requestResponse]);

  useEffect(() => {
    globalShortcuts.registerCustomShortcutCallback("respond_now", () => {
      void requestResponseRef.current();
    });
    return () => {
      globalShortcuts.unregisterCustomShortcutCallback("respond_now");
    };
  }, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      cancelAutoResponse();
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, [cancelAutoResponse]);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    setUseSystemPrompt(true);
  }, []);

  // Update VAD configuration
  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      safeLocalStorage.setItem("vad_config", JSON.stringify(config));
      await invoke("update_vad_config", { config });

      // Fork: start_system_audio_capture clones the VAD config before it
      // spawns the capture task, so a running session keeps the values it
      // started with - update_vad_config only affects the next one. Editing
      // Silence Duration mid-session therefore appeared to do nothing, with
      // no error to explain why. Restart the capture so the edit takes hold.
      // Only the audio side needs this; auto_respond_silence_ms is read live
      // on the frontend, so a delay-only change skips the restart.
      if (capturingRef.current && config.enabled) {
        await invoke("stop_system_audio_capture");
        const deviceId =
          selectedAudioDevices.output.id !== "default"
            ? selectedAudioDevices.output.id
            : null;
        await invoke("start_system_audio_capture", {
          vadConfig: config,
          deviceId,
        });
      }
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, [selectedAudioDevices.output.id]);

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  useEffect(() => {
    if (capturing) {
      setIsContinuousMode(!vadConfig.enabled);

      if (!vadConfig.enabled) {
        setIsRecordingInContinuousMode(false);
      }
    }
  }, [vadConfig.enabled, capturing]);

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Keyboard shortcuts for continuous mode recording (local shortcuts)
  useEffect(() => {
    const handleRecordingShortcuts = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !isContinuousMode) return;
      if (isProcessing || isAIProcessing) return;

      // Enter: Start recording (when not recording) or Stop & Send (when recording)
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!isRecordingInContinuousMode) {
          startContinuousRecording();
        } else {
          manualStopAndSend();
        }
      }

      // Escape: Ignore recording (when recording)
      if (e.key === "Escape" && isRecordingInContinuousMode) {
        e.preventDefault();
        ignoreContinuousRecording();
      }

      // Space: Start recording (when not recording) - only if not typing in input
      if (
        e.key === " " &&
        !isRecordingInContinuousMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        startContinuousRecording();
      }
    };

    window.addEventListener("keydown", handleRecordingShortcuts);
    return () =>
      window.removeEventListener("keydown", handleRecordingShortcuts);
  }, [
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  ]);

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    startNewConversation,
    // Window resize
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    askAboutTranscript,
    // Fork: manual "answer now" trigger for Listen mode
    requestResponse,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
  };
}
