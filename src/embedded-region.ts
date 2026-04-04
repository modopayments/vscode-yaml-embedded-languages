import * as vscode from "vscode";
import packageJson from "@package";
import { Languages } from "./constants";

export interface EmbeddedRegion {
  /** VSCode language ID, e.g. "python", "javascript" */
  languageId: string;
  /** Range of embedded content lines in the original document */
  range: vscode.Range;
}

/**
 * Scans a document for YAML block-scalar regions tagged with an embedded
 * language comment, using the same trigger patterns as the injection grammar:
 *
 *   Prefix:  # yaml-embedded-languages: python
 *   Inline:  script: | # python
 */
export function getEmbeddedRegions(
  document: vscode.TextDocument,
  languages: Languages,
): EmbeddedRegion[] {
  const regions: EmbeddedRegion[] = [];
  const entries = Object.entries(languages);
  const langPatternStr = entries.map(([id]) => id).join("|");

  // Mirrors grammar pattern: # yaml-embedded-languages: python
  const prefixRe = new RegExp(
    `^\\s*#\\s*${packageJson.name}\\s*:\\s*(${langPatternStr})\\s*$`,
    "i",
  );
  // Mirrors grammar disable: # yaml-embedded-languages (no language)
  const disableRe = new RegExp(`^\\s*#\\s*${packageJson.name}\\s*$`, "i");
  // Mirrors inline grammar pattern: | # python  or  >- # javascript
  const inlineRe = new RegExp(
    `(?:\\||>)[1-9]?[-+]?\\s+#\\s*(${langPatternStr})\\s*$`,
    "i",
  );
  // Any block scalar indicator line (without inline language comment)
  const blockRe = /(?:\||>)[1-9]?[-+]?\s*(?:#.*)?$/;

  const resolveLanguageId = (matchedId: string): string | null => {
    for (const [pattern, config] of entries) {
      if (new RegExp(`^(?:${pattern})$`, "i").test(matchedId)) {
        return config.name;
      }
    }
    return null;
  };

  let pendingLanguageId: string | null = null;

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;

    const prefixMatch = line.match(prefixRe);
    if (prefixMatch) {
      pendingLanguageId = resolveLanguageId(prefixMatch[1]);
      continue;
    }

    if (disableRe.test(line)) {
      pendingLanguageId = null;
      continue;
    }

    const inlineMatch = line.match(inlineRe);
    const languageId = inlineMatch
      ? resolveLanguageId(inlineMatch[1])
      : blockRe.test(line)
        ? pendingLanguageId
        : null;

    if (languageId) {
      const region = extractBlock(document, i, languageId);
      if (region) {
        regions.push(region);
        i = region.range.end.line; // skip past the block
      }
    }
  }

  return regions;
}

function extractBlock(
  document: vscode.TextDocument,
  indicatorLine: number,
  languageId: string,
): EmbeddedRegion | null {
  let indent: number | null = null;
  let startLine: number | null = null;
  let endLine = indicatorLine;

  for (let i = indicatorLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;

    if (text.trim() === "") {
      // Blank lines are valid inside a block scalar
      if (startLine !== null) endLine = i;
      continue;
    }

    const currentIndent = text.match(/^( *)/)![1].length;

    if (indent === null) {
      // First non-empty line after the indicator sets the indent level
      if (currentIndent === 0) break; // not indented → not a block
      indent = currentIndent;
      startLine = i;
    } else if (currentIndent < indent) {
      // Dedented past block indent → end of block
      break;
    }

    endLine = i;
  }

  if (startLine === null) return null;

  return {
    languageId,
    range: new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, document.lineAt(endLine).text.length),
    ),
  };
}
