import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel } from "./types.js";

export interface LogMetadata {
  sessionId?: string;
  sessionFile?: string;
  leafId?: string | null;
}

export interface SpikeLogRecord {
  timestamp: string;
  event: string;
  sessionId?: string;
  sessionFile?: string;
  leafId?: string | null;
  payload: Record<string, unknown>;
}

export class NdjsonSpikeLogger {
  readonly filePath: string;
  readonly level: LogLevel;
  lastError: string | undefined;

  constructor(filePath: string, level: LogLevel) {
    this.filePath = filePath;
    this.level = level;
  }

  write(event: string, payload: Record<string, unknown> = {}, metadata: LogMetadata = {}): void {
    if (this.level === "silent") return;

    const record: SpikeLogRecord = {
      timestamp: new Date().toISOString(),
      event,
      payload,
    };
    if (metadata.sessionId !== undefined) record.sessionId = metadata.sessionId;
    if (metadata.sessionFile !== undefined) record.sessionFile = metadata.sessionFile;
    if (metadata.leafId !== undefined) record.leafId = metadata.leafId;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}
