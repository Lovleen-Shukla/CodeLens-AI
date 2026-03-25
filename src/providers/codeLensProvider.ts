import * as vscode from 'vscode';

export class CodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled = vscode.workspace.getConfiguration('codelensai').get<boolean>('enableCodeLens');
    if (!enabled) return [];

    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect function/class declarations across languages
      if (this.isFunctionOrClass(line, document.languageId)) {
        const range = new vscode.Range(i, 0, i, lines[i].length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(sparkle) Explain this',
            command: 'codelensai.explainSelection',
            tooltip: 'Ask CodeLens AI to explain this function or class',
          })
        );
      }
    }

    return lenses;
  }

  private isFunctionOrClass(line: string, lang: string): boolean {
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
