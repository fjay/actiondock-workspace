import { MAX_MATCH_LINE_BYTES } from "./limits.ts";
import { getRipgrepIgnoreGlobs } from "./file-policy.ts";
import type { ActionInput } from "../.actiondock/generated/actions.d.ts";

export type SearchRgInput = ActionInput<"search.rg">;

/**
 * Builds the ripgrep CLI argument list strictly following ripgrep semantics.
 * Mandates --no-config, --json, server limits, and puts pattern after '--'.
 */
export function buildRgArgs(
  input: SearchRgInput,
  resolvedRelativePaths: string[] = []
): string[] {
  const args: string[] = [];

  // Mandatory internal flags (Section 10)
  args.push("--no-config");
  args.push("--json");

  // Max columns enforcement (Section 19)
  const effectiveMaxColumns =
    input["max-columns"] !== undefined
      ? Math.min(input["max-columns"], MAX_MATCH_LINE_BYTES)
      : MAX_MATCH_LINE_BYTES;
  args.push("--max-columns", String(effectiveMaxColumns));

  if (input["max-columns-preview"]) {
    args.push("--max-columns-preview");
  }

  // Supported flags in predictable order (Section 33 & 34)
  if (input["fixed-strings"]) {
    args.push("--fixed-strings");
  }
  if (input["ignore-case"]) {
    args.push("--ignore-case");
  }
  if (input["smart-case"]) {
    args.push("--smart-case");
  }
  if (input["word-regexp"]) {
    args.push("--word-regexp");
  }
  if (input["line-regexp"]) {
    args.push("--line-regexp");
  }

  if (input.hidden) {
    args.push("--hidden");
  }
  if (input["no-ignore"]) {
    args.push("--no-ignore");
  }
  if (input.follow) {
    args.push("--follow");
  }

  if (input.context !== undefined) {
    args.push("-C", String(input.context));
  }
  if (input["before-context"] !== undefined) {
    args.push("-B", String(input["before-context"]));
  }
  if (input["after-context"] !== undefined) {
    args.push("-A", String(input["after-context"]));
  }

  if (input.multiline) {
    args.push("--multiline");
  }
  if (input["multiline-dotall"]) {
    args.push("--multiline-dotall");
  }

  if (input["max-count"] !== undefined) {
    args.push("--max-count", String(input["max-count"]));
  }

  if (input.type && Array.isArray(input.type)) {
    for (const t of input.type) {
      args.push("--type", t);
    }
  }

  if (input["type-not"] && Array.isArray(input["type-not"])) {
    for (const tn of input["type-not"]) {
      args.push("--type-not", tn);
    }
  }

  // Prepend sensitive file filter globs
  const ignoreGlobs = getRipgrepIgnoreGlobs();
  for (const ig of ignoreGlobs) {
    args.push("-g", ig);
  }

  // User globs (preserve order as per section 8.4)
  if (input.glob && Array.isArray(input.glob)) {
    for (const g of input.glob) {
      args.push("-g", g);
    }
  }

  // Pattern MUST follow '--' (Section 11)
  args.push("--");
  args.push(input.pattern);

  // Target paths (relative to workspace root)
  if (resolvedRelativePaths.length > 0) {
    for (const p of resolvedRelativePaths) {
      args.push(p === "" ? "." : p);
    }
  } else {
    args.push(".");
  }

  return args;
}
