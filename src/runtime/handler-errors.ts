export interface HandlerErrorDescription {
  errorName: string;
  errorCode?: string;
  errorLocation?: string;
}

// "at fn (file:///x/y.js:12:3)", "at async fn (C:\x\y.js:12:3)" or "at file:///x/y.js:12:3"
const STACK_FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?\s*$/;
const MAX_LOCATION_LENGTH = 120;

function locationOf(error: Error): string | undefined {
  for (const line of (error.stack ?? "").split("\n")) {
    const match = STACK_FRAME.exec(line);
    if (!match) continue;
    const [, functionName, file, lineNumber] = match;
    if (!file || file.startsWith("node:")) continue; // Node internals say nothing about our code
    const baseName = file.split(/[/\\]/).pop() ?? file;
    const location = functionName ? `${functionName} (${baseName}:${lineNumber})` : `${baseName}:${lineNumber}`;
    return location.slice(0, MAX_LOCATION_LENGTH);
  }
  return undefined;
}

/**
 * What may be logged about a swallowed handler error: its name, an error code, and the first stack
 * frame outside Node internals (function and file:line). The message is deliberately dropped because
 * parser and filesystem errors can embed source text or paths; a frame location carries neither.
 */
export function describeHandlerError(error: unknown): HandlerErrorDescription {
  const code = (error as { code?: unknown } | null)?.code;
  const location = error instanceof Error ? locationOf(error) : undefined;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" ? { errorCode: code } : {}),
    ...(location ? { errorLocation: location } : {}),
  };
}

/**
 * A persistent failure (for example a broken filesystem) would otherwise write one log line per
 * event. Each distinct error is reported on its 1st, 10th, 100th, ... occurrence.
 */
export class HandlerErrorLimiter {
  private readonly counts = new Map<string, number>();

  record(key: string): { log: boolean; occurrences: number } {
    const occurrences = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, occurrences);
    return { log: Number.isInteger(Math.log10(occurrences)), occurrences };
  }
}
