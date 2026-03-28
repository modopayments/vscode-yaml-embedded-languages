import * as vscode from "vscode";
import { Languages } from "./constants";
import { EmbeddedRegion, getEmbeddedRegions } from "./embedded-region";
import {
  VIRTUAL_SCHEME,
  VirtualDocumentProvider,
  buildVirtualContent,
  fromVirtualUri,
  toVirtualUri,
} from "./virtual-document";

const YAML_SELECTOR: vscode.DocumentSelector = [
  { language: "yaml" },
  { language: "github-actions-workflow" },
];

export function regionAt(
  regions: EmbeddedRegion[],
  position: vscode.Position,
): EmbeddedRegion | undefined {
  return regions.find((r) => r.range.contains(position));
}

/**
 * Registers a virtual document provider and language feature providers
 * (hover, completions, go-to-definition, signature help) for YAML files.
 *
 * Uses the VSCode request-forwarding pattern described at:
 * https://code.visualstudio.com/api/language-extensions/embedded-languages
 *
 * Requests are intercepted at the YAML document, a virtual document is
 * constructed for the embedded language (with surrounding YAML replaced by
 * spaces to preserve character offsets), and then the request is delegated
 * to the existing language extension via `executeCommand`.
 */
export function registerEmbeddedLanguageFeatures(
  context: vscode.ExtensionContext,
  getLanguages: () => Languages,
): void {
  // --- Virtual document provider ---

  const provider = new VirtualDocumentProvider((originalUri, region) => {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === originalUri.toString(),
    );
    if (!doc) return "";
    return buildVirtualContent(doc, region);
  });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      VIRTUAL_SCHEME,
      provider,
    ),
  );

  // Notify virtual docs when the underlying YAML file changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        !["yaml", "github-actions-workflow"].includes(e.document.languageId)
      ) {
        return;
      }
      const regions = getEmbeddedRegions(e.document, getLanguages());
      const seen = new Set<string>();
      for (const region of regions) {
        if (seen.has(region.languageId)) continue;
        seen.add(region.languageId);
        const virtualUri = toVirtualUri(e.document.uri, region);
        provider.notifyChanged(virtualUri);
        // Force VSCode to immediately re-fetch and propagate the updated
        // content to the LSP, rather than waiting for its lazy refresh.
        vscode.workspace.openTextDocument(virtualUri);
      }
    }),
  );

  // --- Hover ---

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(YAML_SELECTOR, {
      async provideHover(document, position) {
        const region = regionAt(
          getEmbeddedRegions(document, getLanguages()),
          position,
        );
        if (!region) return;

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          toVirtualUri(document.uri, region),
          position,
        );
        if (!hovers?.length) return;
        return new vscode.Hover(hovers.flatMap((h) => h.contents));
      },
    }),
  );

  // --- Completions ---

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      YAML_SELECTOR,
      {
        async provideCompletionItems(document, position, _token, ctx) {
          const region = regionAt(
            getEmbeddedRegions(document, getLanguages()),
            position,
          );
          if (!region) return;

          const result = await vscode.commands.executeCommand<
            vscode.CompletionList | vscode.CompletionItem[]
          >(
            "vscode.executeCompletionItemProvider",
            toVirtualUri(document.uri, region),
            position,
            ctx.triggerCharacter,
          );
          if (!result) return;
          return Array.isArray(result) ? result : result.items;
        },
      },
      // Common trigger characters across languages; providers filter the rest
      // TODO: Claude made these up
      ".",
      ":",
      '"',
      "'",
      "/",
      "<",
      "{",
      "(",
      "@",
    ),
  );

  // --- Go to definition ---

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(YAML_SELECTOR, {
      async provideDefinition(document, position) {
        const region = regionAt(
          getEmbeddedRegions(document, getLanguages()),
          position,
        );
        if (!region) return;

        const result = await vscode.commands.executeCommand<vscode.Definition>(
          "vscode.executeDefinitionProvider",
          toVirtualUri(document.uri, region),
          position,
        );
        if (!result) return;

        // Map virtual document URIs back to the original YAML document
        const mapUri = (uri: vscode.Uri) =>
          uri.scheme === VIRTUAL_SCHEME ? fromVirtualUri(uri).originalUri : uri;

        const locations = Array.isArray(result) ? result : [result];
        return locations.map((item) => {
          if (item instanceof vscode.Location) {
            return new vscode.Location(mapUri(item.uri), item.range);
          }
          const link = item as vscode.LocationLink;
          return new vscode.Location(
            mapUri(link.targetUri),
            link.targetSelectionRange ?? link.targetRange,
          );
        });
      },
    }),
  );

  // --- Signature help ---

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      YAML_SELECTOR,
      {
        async provideSignatureHelp(document, position) {
          const region = regionAt(
            getEmbeddedRegions(document, getLanguages()),
            position,
          );
          if (!region) return;

          return vscode.commands.executeCommand<vscode.SignatureHelp>(
            "vscode.executeSignatureHelpProvider",
            toVirtualUri(document.uri, region),
            position,
          );
        },
      },
      "(",
      ",",
    ),
  );

  // --- Find references ---

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(YAML_SELECTOR, {
      async provideReferences(document, position) {
        const region = regionAt(
          getEmbeddedRegions(document, getLanguages()),
          position,
        );
        if (!region) return;

        const result = await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          toVirtualUri(document.uri, region),
          position,
        );
        if (!result?.length) return;

        // Map virtual document URIs back to the original YAML document
        const mapUri = (uri: vscode.Uri) =>
          uri.scheme === VIRTUAL_SCHEME ? fromVirtualUri(uri).originalUri : uri;

        return result.map(
          (loc) => new vscode.Location(mapUri(loc.uri), loc.range),
        );
      },
    }),
  );

  // --- Folding ranges ---

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(YAML_SELECTOR, {
      async provideFoldingRanges(document) {
        const regions = getEmbeddedRegions(document, getLanguages());
        if (!regions.length) return;

        const all: vscode.FoldingRange[] = [];
        for (const region of regions) {
          let result: vscode.FoldingRange[] = [];
          try {
            result = await vscode.commands.executeCommand<
              vscode.FoldingRange[]
            >(
              "vscode.executeFoldingRangeProvider",
              toVirtualUri(document.uri, region),
            );
          } catch {
            continue; // Not clue why this seems to fail sometimes! But this works
          }
          if (!result?.length) continue;

          const { start, end } = region.range;
          for (const fr of result) {
            if (fr.start >= start.line && fr.end <= end.line) {
              all.push(fr);
            }
          }
        }
        return all;
      },
    }),
  );

}
