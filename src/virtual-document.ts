import * as vscode from "vscode";
import { EmbeddedRegion } from "./embedded-region";
import { currentLanguages } from "./extension";

export const VIRTUAL_SCHEME = "yaml-embedded";

/**
 * Encodes an original YAML document URI + target language into a virtual URI.
 * The original URI is stored in the query string so it survives round-trips.
 *
 * Example: yaml-embedded:/python/<languageId>/start_line/start_char/end_line/end_char//Users/foo/bar.yaml.py?file:///Users/foo/bar.yaml
 */
export function toVirtualUri(
  originalUri: vscode.Uri,
  region: EmbeddedRegion,
): vscode.Uri {
  const uri = vscode.Uri.from({
    scheme: VIRTUAL_SCHEME,
    // path: `/${region.languageId}/${region.range.start.line}/${region.range.start.character}/${region.range.end.line}/${region.range.end.character}/${originalUri.fsPath}.${VIRTUAL_SCHEME}-${region.languageId}`,
    path: `/${region.languageId}/${region.range.start.line}/${region.range.start.character}/${region.range.end.line}/${region.range.end.character}/${originalUri.fsPath}.${currentLanguages[region.languageId].scopeName}`,
    // path: `/${region.languageId}/${region.range.start.line}/${region.range.start.character}/${region.range.end.line}/${region.range.end.character}/${originalUri.fsPath}.${region.languageId}`,
    query: originalUri.toString(),
  });
  return uri;
}

export function fromVirtualUri(virtualUri: vscode.Uri): {
  originalUri: vscode.Uri;
  region: EmbeddedRegion;
} {
  // path is /<languageId>/start_line/start_char/end_line/end_char/<fsPath>
  const segments = virtualUri.path.split("/");
  return {
    originalUri: vscode.Uri.parse(virtualUri.query),
    region: {
      languageId: segments[1],
      range: new vscode.Range(
        new vscode.Position(parseInt(segments[2]), parseInt(segments[3])),
        new vscode.Position(parseInt(segments[4]), parseInt(segments[5])),
      ),
    },
  };
}

/**
 * Builds virtual document content for a given language.
 *
 * All lines belonging to an embedded region of `languageId` are kept verbatim.
 * Every other line is replaced with spaces of the same length so that character
 * offsets remain identical to the original document — no position translation
 * is required when forwarding requests.
 *
 * When multiple embedded blocks of the same language exist in one YAML file,
 * all of them appear in the single virtual document, enabling cross-block
 * features like go-to-definition.
 */
export function buildVirtualContent(
  document: vscode.TextDocument,
  region: EmbeddedRegion,
): string {
  const embeddedLines = new Set<number>();
  for (let l = region.range.start.line; l <= region.range.end.line; l++) {
    embeddedLines.add(l);
  }

  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    lines.push(embeddedLines.has(i) ? text : " ".repeat(text.length));
  }
  return lines.join("\n");
}

export class VirtualDocumentProvider
  implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getContent: (
      originalUri: vscode.Uri,
      region: EmbeddedRegion,
    ) => string,
  ) { }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { originalUri, region } = fromVirtualUri(uri);
    const cont = this.getContent(originalUri, region);
    return cont;
  }

  notifyChanged(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }
}
