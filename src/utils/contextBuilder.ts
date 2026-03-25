import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const IGNORE_DIRS = new Set([
  // JS/TS
  'node_modules', 'dist', 'out', 'build', '.next', '.nuxt', '.output',
  'coverage', '.cache', '.turbo', '.parcel-cache', 'storybook-static',
  // Python envs & package caches
  '__pycache__', '.venv', 'venv', 'venv_3', 'env', '.env',
  'site-packages', 'conda-meta', 'conda', 'miniconda', 'anaconda',
  'Lib', 'lib', 'lib64', 'include', 'Scripts', 'bin',
  // Version control & tooling
  '.git', '.svn', '.hg',
  // IDE / OS
  '.idea', '.vscode', '__MACOSX', '.DS_Store',
  // Build artifacts
  'target', 'cmake-build-debug', 'cmake-build-release',
  '.gradle', '.mvn', 'vendor',
  // Lock / generated
  'generated', '.gen', 'proto',
]);

/** Extra check: skip any directory that looks like a virtual environment */
function isEnvDir(dirPath: string): boolean {
  const name = require('path').basename(dirPath).toLowerCase();
  // Common venv patterns: venv_3, .venv, env3, venv39, myenv, etc.
  if (/^(venv|\.venv|env|\.env)[_\-.]?\d*$/.test(name)) return true;
  // Conda environments often contain a conda-meta subfolder
  try {
    const fs = require('fs');
    return fs.existsSync(require('path').join(dirPath, 'conda-meta')) ||
           fs.existsSync(require('path').join(dirPath, 'pyvenv.cfg'));
  } catch { return false; }
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.cs', '.cpp', '.c', '.h', '.rb', '.php', '.swift', '.kt',
  '.vue', '.svelte', '.html', '.css', '.scss',
  '.yaml', '.yml', '.toml', '.sh', '.env.example',
  // JSON only for root-level config files, not deep package metadata
  '.json',
]);

/** Return true for json files that are likely package metadata, not source */
function isNoiseFile(filePath: string): boolean {
  const p = require('path');
  const name = p.basename(filePath);
  const rel = filePath.replace(/\\/g, '/');
  // Skip conda/pip metadata json
  if (rel.includes('conda-meta/') || rel.includes('conda-meta\\')) return true;
  if (rel.includes('site-packages/') || rel.includes('site-packages\\')) return true;
  // Skip lock files
  if (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'composer.lock'].includes(name)) return true;
  return false;
}

export interface FileNode {
  path: string;
  relativePath: string;
  imports: string[];
  size: number;
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Read a file safely, truncating if too large */
export function readFileSafe(filePath: string, maxBytes = 50000): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      return buf.toString('utf8') + '\n\n[... file truncated for length ...]';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Get all code files in the workspace (up to limit) */
export function getWorkspaceFiles(rootPath: string, limit = 200): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);
        if (!IGNORE_DIRS.has(entry.name) && !isEnvDir(fullPath)) walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const fp = path.join(dir, entry.name);
        if (CODE_EXTENSIONS.has(ext) && !isNoiseFile(fp)) files.push(fp);
      }
    }
  }

  walk(rootPath);
  return files;
}

/** Build a compact file tree string for AI context */
export function buildFileTree(rootPath: string): string {
  const lines: string[] = [];

  function walk(dir: string, indent = '') {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory() && (IGNORE_DIRS.has(entry.name) || isEnvDir(path.join(dir, entry.name)))) continue;
      lines.push(indent + (entry.isDirectory() ? `📁 ${entry.name}/` : `  ${entry.name}`));
      if (entry.isDirectory()) walk(path.join(dir, entry.name), indent + '  ');
    }
  }

  walk(rootPath);
  return lines.slice(0, 150).join('\n');
}

/** Extract import paths from a file (basic regex approach, works for JS/TS/Python) */
export function extractImports(content: string, filePath: string): string[] {
  const imports: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const re = /(?:import|require)\s*(?:\(?\s*['"]([^'"]+)['"]\s*\)?|.*?from\s+['"]([^'"]+)['"])/g;
    let m;
    while ((m = re.exec(content)) !== null) imports.push(m[1] || m[2]);
  } else if (ext === '.py') {
    const re = /(?:import|from)\s+([^\s;]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) imports.push(m[1]);
  }

  return imports.filter(i => i.startsWith('.')); // only local imports
}

/** Build a summary of files and their imports for the dependency graph */
export function buildDependencyMap(rootPath: string): FileNode[] {
  const files = getWorkspaceFiles(rootPath, 100);
  return files.map(filePath => {
    const content = readFileSafe(filePath, 20000);
    return {
      path: filePath,
      relativePath: path.relative(rootPath, filePath),
      imports: extractImports(content, filePath),
      size: fs.statSync(filePath).size,
    };
  });
}

/** Gather context about the current file + its neighbors for AI prompts */
export function buildFileContext(filePath: string, rootPath: string): string {
  const content = readFileSafe(filePath);
  const relativePath = path.relative(rootPath, filePath);
  const imports = extractImports(content, filePath);
  const tree = buildFileTree(rootPath);

  return `
=== PROJECT FILE TREE ===
${tree}

=== FILE BEING EXPLAINED ===
Path: ${relativePath}
Size: ${fs.statSync(filePath).size} bytes

=== LOCAL IMPORTS IN THIS FILE ===
${imports.length ? imports.join('\n') : 'None'}

=== FILE CONTENTS ===
${content}
`.trim();
}

/** Detect the project's tech stack */
export function detectTechStack(rootPath: string): string[] {
  const stack: string[] = [];
  const check = (file: string) => fs.existsSync(path.join(rootPath, file));

  if (check('package.json')) {
    stack.push('Node.js / JavaScript');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['react']) stack.push('React');
      if (deps['next']) stack.push('Next.js');
      if (deps['vue']) stack.push('Vue');
      if (deps['svelte']) stack.push('Svelte');
      if (deps['express']) stack.push('Express');
      if (deps['typescript']) stack.push('TypeScript');
    } catch {}
  }
  if (check('requirements.txt') || check('pyproject.toml')) stack.push('Python');
  if (check('go.mod')) stack.push('Go');
  if (check('Cargo.toml')) stack.push('Rust');
  if (check('pom.xml') || check('build.gradle')) stack.push('Java');
  if (check('Gemfile')) stack.push('Ruby');
  if (check('composer.json')) stack.push('PHP');
  if (check('Dockerfile')) stack.push('Docker');
  if (check('.github/workflows')) stack.push('GitHub Actions');
  if (check('prisma/schema.prisma')) stack.push('Prisma');

  return stack;
}
