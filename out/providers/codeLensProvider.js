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
exports.CodeLensProvider = void 0;
const vscode = __importStar(require("vscode"));
class CodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }
    provideCodeLenses(document) {
        const enabled = vscode.workspace.getConfiguration('codelensai').get('enableCodeLens');
        if (!enabled)
            return [];
        const lenses = [];
        const text = document.getText();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Detect function/class declarations across languages
            if (this.isFunctionOrClass(line, document.languageId)) {
                const range = new vscode.Range(i, 0, i, lines[i].length);
                lenses.push(new vscode.CodeLens(range, {
                    title: '$(sparkle) Explain this',
                    command: 'codelensai.explainSelection',
                    tooltip: 'Ask CodeLens AI to explain this function or class',
                }));
            }
        }
        return lenses;
    }
    isFunctionOrClass(line, lang) {
        // JS/TS
        if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(lang)) {
            return /^(export\s+)?(default\s+)?(async\s+)?(function\s+\w+|const\s+\w+\s*=\s*(async\s+)?\(|class\s+\w+|arrow|\w+\s*:\s*(async\s+)?function)/.test(line);
        }
        // Python
        if (lang === 'python') {
            return /^(def |async def |class )\w+/.test(line);
        }
        // Go
        if (lang === 'go') {
            return /^func\s+/.test(line);
        }
        // Rust
        if (lang === 'rust') {
            return /^(pub\s+)?(async\s+)?fn\s+/.test(line);
        }
        // Java/C#
        if (['java', 'csharp'].includes(lang)) {
            return /^(public|private|protected|static|async|override|virtual).*[\w>]\s+\w+\s*\(/.test(line);
        }
        // Ruby
        if (lang === 'ruby') {
            return /^(def |class |module )\w+/.test(line);
        }
        // PHP
        if (lang === 'php') {
            return /^(public|private|protected|static)?\s*(function)\s+\w+/.test(line);
        }
        return false;
    }
}
exports.CodeLensProvider = CodeLensProvider;
//# sourceMappingURL=codeLensProvider.js.map