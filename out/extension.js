"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const aiClient_1 = require("./utils/aiClient");
const codeLensProvider_1 = require("./providers/codeLensProvider");
const hoverProvider_1 = require("./providers/hoverProvider");
const dashboardPanel_1 = require("./panels/dashboardPanel");
const commands_1 = require("./utils/commands");
function activate(context) {
    console.log('CodeLens AI is now active');
    const aiClient = new aiClient_1.AIClient(context);
    // ── Sidebar icon click → open dashboard ────────────────────────────────
    // Register a minimal WebviewView so the activity bar icon appears.
    // When the user clicks the icon, we open the full dashboard panel.
    const sidebarProvider = {
        resolveWebviewView(view) {
            view.webview.options = { enableScripts: true };
            view.webview.html = `<!DOCTYPE html><html><head><style>
        body{background:#0d0f14;color:#6b7280;font-family:'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;margin:0;text-align:center}
        button{background:#6c63ff;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit}
        button:hover{background:#8078ff}
        .logo{font-size:16px;font-weight:700;color:#e2e4ed}
        .logo span{color:#6c63ff}
        p{font-size:12px;line-height:1.6;max-width:180px}
      </style></head><body>
        <div class="logo">Code<span>Lens</span> AI</div>
        <p>Open the full dashboard to explore your codebase</p>
        <button onclick="acquireVsCodeApi().postMessage({type:'open'})">Open Dashboard</button>
      </body></html>`;
            view.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'open')
                    vscode.commands.executeCommand('codelensai.openDashboard');
            });
            // Auto-open dashboard when sidebar is first revealed
            setTimeout(() => vscode.commands.executeCommand('codelensai.openDashboard'), 300);
        }
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codelensai.sidebarView', sidebarProvider));
    // ── CodeLens hints above functions ─────────────────────────────────────
    context.subscriptions.push(vscode.languages.registerCodeLensProvider('*', new codeLensProvider_1.CodeLensProvider()));
    // ── Hover provider ──────────────────────────────────────────────────────
    context.subscriptions.push(vscode.languages.registerHoverProvider('*', new hoverProvider_1.HoverProvider(aiClient)));
    // ── Commands ────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('codelensai.openDashboard', () => {
        dashboardPanel_1.DashboardPanel.show(context, aiClient);
    }), vscode.commands.registerCommand('codelensai.explainFile', async (uri) => {
        await (0, commands_1.explainFile)(aiClient, uri);
    }), vscode.commands.registerCommand('codelensai.explainSelection', async () => {
        await (0, commands_1.explainSelection)(aiClient);
    }), vscode.commands.registerCommand('codelensai.projectOverview', async () => {
        await (0, commands_1.projectOverview)(aiClient);
    }), vscode.commands.registerCommand('codelensai.showDependencyGraph', () => {
        dashboardPanel_1.DashboardPanel.show(context, aiClient);
    }), vscode.commands.registerCommand('codelensai.generateReadme', async () => {
        await (0, commands_1.generateReadme)(aiClient);
    }), vscode.commands.registerCommand('codelensai.openChat', () => {
        dashboardPanel_1.DashboardPanel.show(context, aiClient);
    }), vscode.commands.registerCommand('codelensai.setApiKey', async () => {
        const provider = aiClient.getProvider();
        const cfg = aiClient.getProviderConfig();
        if (provider === 'ollama') {
            vscode.window.showInformationMessage('Ollama runs locally — no API key needed!');
            return;
        }
        const placeholder = {
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
    }), vscode.commands.registerCommand('codelensai.switchProvider', async () => {
        const current = aiClient.getProvider();
        const items = Object.entries(aiClient_1.PROVIDERS).map(([id, cfg]) => ({
            label: cfg.name,
            description: id === current ? '✓ active' : '',
            detail: `Default: ${cfg.defaultModel}  |  Models: ${cfg.models.slice(0, 3).join(', ')}`,
            id,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: 'CodeLens AI — Switch Provider',
            placeHolder: 'Select an AI provider',
            matchOnDetail: true,
        });
        if (!picked)
            return;
        const config = vscode.workspace.getConfiguration('codelensai');
        await config.update('provider', picked.id, vscode.ConfigurationTarget.Global);
        await config.update('model', '', vscode.ConfigurationTarget.Global);
        if (picked.id === 'ollama') {
            vscode.window.showInformationMessage(`Switched to ${picked.label}. Make sure Ollama is running.`);
        }
        else {
            const choice = await vscode.window.showInformationMessage(`Switched to ${picked.label}. Set API key now?`, 'Set API Key', 'Later');
            if (choice === 'Set API Key')
                vscode.commands.executeCommand('codelensai.setApiKey');
        }
    }), vscode.commands.registerCommand('codelensai.showProviderStatus', async () => {
        const cfg = aiClient.getProviderConfig();
        const model = aiClient.getModel();
        const choice = await vscode.window.showInformationMessage(`CodeLens AI · ${cfg.name} · ${model}`, 'Switch Provider', 'Change Model');
        if (choice === 'Switch Provider')
            vscode.commands.executeCommand('codelensai.switchProvider');
        if (choice === 'Change Model') {
            const m = await vscode.window.showInputBox({ prompt: `Model for ${cfg.name}`, value: model });
            if (m)
                vscode.workspace.getConfiguration('codelensai').update('model', m, vscode.ConfigurationTarget.Global);
        }
    }));
    // First-run prompt
    const provider = aiClient.getProvider();
    context.secrets.get(`codelensai.apiKey.${provider}`).then(key => {
        if (!key && provider !== 'ollama') {
            vscode.window.showInformationMessage('CodeLens AI is ready! Open the dashboard to get started.', 'Open Dashboard', 'Set API Key').then(choice => {
                if (choice === 'Open Dashboard')
                    vscode.commands.executeCommand('codelensai.openDashboard');
                if (choice === 'Set API Key')
                    vscode.commands.executeCommand('codelensai.setApiKey');
            });
        }
    });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map