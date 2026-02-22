/**
 * Shared CLI argument helpers.
 * Extracts the duplicated getFlag pattern from parser.ts, generator.ts, sender.ts.
 */

const args = process.argv.slice(2);

export function hasFlag(name: string): boolean {
  return args.includes(name);
}

export function getStringFlag(name: string): string | undefined;
export function getStringFlag(name: string, defaultVal: string): string;
export function getStringFlag(name: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

export function getNumericFlag(name: string, defaultVal: number): number {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return defaultVal;
  const raw = args[idx + 1];
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    console.error(`Error: "${name}" must be a non-negative number, got "${raw}".`);
    process.exit(1);
  }
  return num;
}

export function getPositionalArg(index: number): string | undefined {
  return args[index];
}
