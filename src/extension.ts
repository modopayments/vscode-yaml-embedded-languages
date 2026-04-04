import vscode from "vscode";
import packageJson from "@package";
import {
  INCLUDE_CONFIG,
  LANGUAGES,
  Languages,
  SUB_INCLUDE_CONFIG,
  VERSION_STATE,
} from "./constants";
import { generateFiles, parseLanguages } from "./generate";
import { registerEmbeddedLanguageFeatures } from "./language-features";

export let currentLanguages: Languages = parseLanguages({
  ...LANGUAGES,
  ...vscode.workspace.getConfiguration(packageJson.name)[SUB_INCLUDE_CONFIG],
});

const updateExtension = () => {
  const settings = vscode.workspace.getConfiguration(packageJson.name);
  const includeLanguages = settings[SUB_INCLUDE_CONFIG];
  const allLanguages = { ...LANGUAGES, ...includeLanguages };

  currentLanguages = parseLanguages(allLanguages);

  const filesChanged = generateFiles(allLanguages);

  if (filesChanged) {
    const message = `Reload window to allow changes to take effect?`;
    const items = ["Yes", "No"];
    vscode.window.showInformationMessage(message, ...items).then((item) => {
      if (item === items[0]) {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
  }
};

export const activate = (context: vscode.ExtensionContext) => {
  const currentVersion = packageJson.version;
  const previousVersion = context.globalState.get(VERSION_STATE);

  if (previousVersion !== currentVersion) {
    updateExtension();
    context.globalState.update(VERSION_STATE, currentVersion);
  }

  const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(INCLUDE_CONFIG)) {
      updateExtension();
    }
  });

  context.subscriptions.push(disposable);

  registerEmbeddedLanguageFeatures(context, () => currentLanguages);
};

export const deactivate = () => { };
