// Offline fake of Pi's ExtensionAPI: records handlers, commands and appended entries so tests can drive the
// extension event by event without starting Pi.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Handler = (event: any, ctx: any) => any;

export interface Harness {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  /** The whole registration (description, argument completions) of each command. */
  commandOptions: Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => any; handler: (args: string, ctx: any) => Promise<void> }>;
  branchEntries: any[];
  notifications: string[];
  statuses: Array<string | undefined>;
  ctx: ExtensionContext;
  /** Fault-injection tests set this; every other test must not see a swallowed handler error. */
  allowHandlerErrors: boolean;
  invoke(event: string, payload: any): Promise<any>;
}

const createdHarnesses: Harness[] = [];

export function createHarness(cwd: string, options: { trusted?: boolean } = {}): Harness {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const commandOptions: Harness["commandOptions"] = new Map();
  const branchEntries: any[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];

  const api = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    appendEntry(customType: string, data: unknown) {
      branchEntries.push({ type: "custom", customType, data });
    },
    registerCommand(name: string, options: Harness["commandOptions"] extends Map<string, infer T> ? T : never) {
      commands.set(name, options.handler);
      commandOptions.set(name, options);
    },
  } as unknown as ExtensionAPI;

  const sessionManager = {
    getSessionId: () => "session-1",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => "leaf-1",
    getBranch: () => branchEntries,
  };

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? true,
    isIdle: () => true,
    sessionManager,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
    },
  } as unknown as ExtensionContext;

  const harness: Harness = {
    api,
    handlers,
    commands,
    commandOptions,
    branchEntries,
    notifications,
    statuses,
    ctx,
    allowHandlerErrors: false,
    async invoke(event: string, payload: any): Promise<any> {
      let result: any;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
  createdHarnesses.push(harness);
  return harness;
}

// The extension swallows handler errors (fail-open) and only logs them, so without this check a
// handler bug would stay invisible to every test that does not assert on its side effects.
// Register it with `afterEach(assertNoSwallowedHandlerErrors)` in every test file that uses createHarness.
export function assertNoSwallowedHandlerErrors(): void {
  const swallowed: string[] = [];
  for (const harness of createdHarnesses.splice(0)) {
    if (harness.allowHandlerErrors) continue;
    const logPath = join(String(harness.ctx.cwd), ".pi", "convention-sense", "observe.ndjson");
    if (!existsSync(logPath)) continue;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (line.includes('"event":"handler_error"')) swallowed.push(line);
    }
  }
  assert.deepEqual(swallowed, [], "a handler threw: the fail-open wrapper hid it from this test");
}
