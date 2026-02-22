/**
 * Shared file I/O utilities.
 * Extracts ensureDataDir(), saveJson(), and buildTimestampedFilename()
 * from parser.ts and generator.ts.
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

export function ensureDataDir(): string {
  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function saveJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Saved: ${filePath}`);
}

export function buildTimestampedFilename(prefix: string, suffix: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safePrefix}_${suffix}_${timestamp}.json`;
}
