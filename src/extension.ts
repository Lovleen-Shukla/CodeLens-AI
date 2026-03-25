import * as vscode from 'vscode';
import { AIClient, PROVIDERS } from './utils/aiClient';
import { CodeLensProvider } from './providers/codeLensProvider';
import { HoverProvider } from './providers/hoverProvider';
import { DashboardPanel } from './panels/dashboardPanel';
import { explainFile, explainSelection, projectOverview, generateReadme } from './utils/commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('CodeLens AI is now active');
  const aiClient = new AIClient(context);

  // ── CodeLens hints above functions ─────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider('*', new CodeLensProvider())
  );

  // ── Hover provider ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('*', new HoverProvider(aiClient))
  );

  // ── Commands ────────────────────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('codelensai.openDashboard', () => {
      DashboardPanel.show(context, aiClient);
    }),

    vscode.commands.registerCommand('codelensai.explainFile', async (uri?: vscode.Uri) => {
      await explainFile(aiClient, uri);
    }),

    vscode.commands.registerCommand('codelensai.explainSelection', async () => {
      await explainSelection(aiClient);
    }),

    vscode.commands.registerCommand('codelensai.projectOverview', async () => {
      await projectOverview(aiClient);
    }),

    vscode.commands.registerCommand('codelensai.showDependencyGraph', () => {
      DashboardPanel.show(context, aiClient);
    }),

    vscode.commands.registerCommand('codelensai.generateReadme', async () => {
      await generateReadme(aiClient);
    }),

    vscode.commands.registerCommand('codelensai.openChat', () => {
      DashboardPanel.show(context, aiClient);
    }),

    vscode.commands.registerCommand('codelensai.setApiKey', async () => {
      const provider = aiClient.getProvider();
      const cfg = aiClient.getProviderConfig();
      if (provider === 'ollama') {
        vscode.window.showInformationMessage('Ollama runs locally — no API key needed!');
        return;
      }
      const placeholder: Record<string, string> = {
        anthropic: 'sk-ant-api03-...',
        openai: 'sk-...',
        gemini: 'AIza...',
        groq: 'gsk_...',
      };
      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${cfg.name} API key`,
        password: true,
        placeHolder: placeholder[provider] ?? 'Your API key',
      });
      if (key) {
        await aiClient.setApiKey(key);
        vscode.window.showInformationMessage(`CodeLens AI: ${cfg.name} API key saved!`);
      }
    }),

    vscode.commands.registerCommand('codelensai.switchProvider', async () => {
      const current = aiClient.getProvider();
      const items = Object.entries(PROVIDERS).map(([id, cfg]) => ({
        label: cfg.name,
        description: id === current ? '✓ active' : '',
        detail: `Default: ${cfg.defaultModel}  |  Models: ${cfg.models.slice(0,3).join(', ')}`,
        id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'CodeLens AI — Switch Provider',
        placeHolder: 'Select an AI provider',
        matchOnDetail: true,
      });
      if (!picked) return;
      const config = vscode.workspace.getConfiguration('codelensai');
      await config.update('provider', picked.id, vscode.ConfigurationTarget.Global);
      await config.update('model', '', vscode.ConfigurationTarget.Global);
      if (picked.id === 'ollama') {
        vscode.window.showInformationMessage(`Switched to ${picked.label}. Make sure Ollama is running.`);
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Switched to ${picked.label}. Set API key now?`, 'Set API Key', 'Later'
        );
        if (choice === 'Set API Key') vscode.commands.executeCommand('codelensai.setApiKey');
      }
    }),

    vscode.commands.registerCommand('codelensai.showProviderStatus', async () => {
      const cfg = aiClient.getProviderConfig();
      const model = aiClient.getModel();
      const choice = await vscode.window.showInformationMessage(
        `CodeLens AI · ${cfg.name} · ${model}`, 'Switch Provider', 'Change Model'
      );
      if (choice === 'Switch Provider') vscode.commands.executeCommand('codelensai.switchProvider');
      if (choice === 'Change Model') {
        const m = await vscode.window.showInputBox({ prompt: `Model for ${cfg.name}`, value: model });
        if (m) vscode.workspace.getConfiguration('codelensai').update('model', m, vscode.ConfigurationTarget.Global);
      }
    })
  );

  // First-run prompt
  const provider = aiClient.getProvider();
  context.secrets.get(`codelensai.apiKey.${provider}`).then(key => {
    if (!key && provider !== 'ollama') {
      vscode.window.showInformationMessage(
        'CodeLens AI is ready! Open the dashboard to get started.',
        'Open Dashboard', 'Set API Key'
      ).then(choice => {
        if (choice === 'Open Dashboard') vscode.commands.executeCommand('codelensai.openDashboard');
        if (choice === 'Set API Key') vscode.commands.executeCommand('codelensai.setApiKey');
      });
    }
  });
}

export function deactivate() {}
