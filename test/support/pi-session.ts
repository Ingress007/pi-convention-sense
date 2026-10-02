// Offline harness for REAL Pi lifecycle tests: the real agent loop, tool runner and extension runner,
// driven by a scripted faux model. No network, no credentials, no model cost.
//
// The faux provider is imported here and nowhere else, so the dev dependency on @earendil-works/pi-ai
// can be replaced by changing this single file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { registerConventionSenseSpike, type SpikeExtensionRuntime } from "../../extensions/index.js";

export interface ToolCallSpec {
  name: string;
  args: ToolCall["arguments"];
}

export interface ToolOutcome {
  tool: string;
  isError: boolean;
  text: string;
}

export interface LogRecord {
  event: string;
  payload: Record<string, any>;
}

export interface PiHarness {
  cwd: string;
  session: AgentSession;
  faux: FauxProviderHandle;
  /** Extension runtime handle, available once the extension factory has run. */
  runtime(): SpikeExtensionRuntime;
  /** Errors reported by Pi's extension runner (load-time and runtime). */
  extensionErrors: string[];
  /** Messages the extension showed through `ctx.ui.notify` (only with `captureUi`). */
  notifications: string[];
  /** Values the extension set through `ctx.ui.setStatus` (only with `captureUi`). */
  statuses: Array<string | undefined>;
  /** Results of every tool execution, in order. */
  toolOutcomes: ToolOutcome[];
  /** The structured transcript messages the model saw at each request, in order. */
  modelMessages: Array<Array<{ role: string; content?: unknown }>>;
  /** The same requests flattened to text, for regular-expression assertions. */
  readonly modelRequests: string[];
  /** Replace the scripted model responses and run one prompt to completion. */
  run(steps: FauxResponseStep[], prompt?: string): Promise<void>;
  /** NDJSON records written by the extension. */
  logRecords(): LogRecord[];
  dispose(): void;
}

/** One assistant turn that calls tools (the agent loop then executes them and asks the model again). */
export function toolTurn(...calls: ToolCallSpec[]): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(
    calls.map((call, index) => fauxToolCall(call.name, call.args, { id: `call-${call.name}-${index}` })),
    { stopReason: "toolUse" },
  );
}

/** A final assistant turn with plain text. */
export function finalTurn(text = "done"): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxText(text)]);
}

export interface PiHarnessOptions {
  /** Directory copied into the temporary project before the session starts. */
  seed?: (cwd: string) => void;
  /** Written to `.pi/convention-sense.json` in the project. */
  config?: Record<string, unknown>;
  /** Called with the extension runtime once the factory has run (for fault injection). */
  onRuntime?: (runtime: SpikeExtensionRuntime) => void;
  /** Give the extension a UI that records notifications and status, as interactive Pi would. */
  captureUi?: boolean;
  /** Pi compaction settings; automatic compaction stays off. A tiny `keepRecentTokens` lets a short session compact. */
  compaction?: { keepRecentTokens?: number; reserveTokens?: number };
}

function flatten(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function createPiHarness(options: PiHarnessOptions = {}): Promise<PiHarness> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-real-"));
  const agentDir = join(cwd, ".pi-agent");
  mkdirSync(agentDir, { recursive: true });
  options.seed?.(cwd);
  if (options.config) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "convention-sense.json"), JSON.stringify(options.config));
  }

  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  let runtime: SpikeExtensionRuntime | undefined;
  const extensionFactory = (pi: ExtensionAPI): void => {
    runtime = registerConventionSenseSpike(pi);
    options.onRuntime?.(runtime);
  };

  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false, ...(options.compaction ?? {}) }, retry: { enabled: false } },
    { projectTrusted: true },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: "convention-sense", factory: extensionFactory }],
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: "off",
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: ["read", "edit", "write"],
  });

  const extensionErrors = extensionsResult.errors.map((error) => `${error.path}: ${error.error}`);
  // Print/RPC/interactive modes call this; it is what fires `session_start` for extensions.
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  // Pi copies the UI object's own members, so every method must exist as a real property; only `notify` and
  // `setStatus` record anything, the rest are no-ops.
  const noopMembers = [
    "select", "confirm", "input", "onTerminalInput", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator",
    "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText",
    "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes",
    "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded",
  ];
  const recordingUi = {
    ...Object.fromEntries(noopMembers.map((name) => [name, () => undefined])),
    notify: (message: string) => void notifications.push(message),
    setStatus: (_key: string, text: string | undefined) => void statuses.push(text),
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({
    mode: options.captureUi ? "tui" : "print",
    ...(options.captureUi ? { uiContext: recordingUi } : {}),
    onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`),
  });

  const toolOutcomes: ToolOutcome[] = [];
  const modelMessages: Array<Array<{ role: string; content?: unknown }>> = [];
  session.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    const content = (event.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    toolOutcomes.push({
      tool: event.toolName,
      isError: event.isError,
      text: content.map((block) => block.text ?? "").join("\n"),
    });
  });

  const observeRequest = (step: FauxResponseStep): FauxResponseStep =>
    (context, streamOptions, state, model) => {
      modelMessages.push([...context.messages] as Array<{ role: string; content?: unknown }>);
      return typeof step === "function" ? step(context, streamOptions, state, model) : step;
    };

  return {
    cwd,
    session,
    faux,
    runtime() {
      if (!runtime) throw new Error("the extension factory has not run");
      return runtime;
    },
    extensionErrors,
    notifications,
    statuses,
    toolOutcomes,
    modelMessages,
    get modelRequests() {
      return modelMessages.map(flatten);
    },
    async run(steps, prompt = "please make the change") {
      faux.setResponses(steps.map(observeRequest));
      await session.prompt(prompt);
      await session.waitForIdle();
    },
    logRecords() {
      const logPath = join(cwd, ".pi", "convention-sense", "observe.ndjson");
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const record = JSON.parse(line) as { event: string; payload: Record<string, any> };
          return { event: record.event, payload: record.payload };
        });
    },
    dispose() {
      session.dispose();
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Temporary directory cleanup is best effort (Windows may still hold handles).
      }
    },
  };
}

/** Text of the first user-role message that matches `pattern` (for example an injected review). */
export function userTextMatching(
  messages: Array<{ role: string; content?: unknown }> | undefined,
  pattern: RegExp,
): string {
  for (const message of messages ?? []) {
    if (message.role !== "user") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block as { text?: string }).text ?? "").join("\n")
        : "";
    if (pattern.test(text)) return text;
  }
  return "";
}
