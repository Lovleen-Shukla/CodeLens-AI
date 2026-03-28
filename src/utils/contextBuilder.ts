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
      
      const name = entry.name;
      const lowerName = name.toLowerCase();

      // Skip hidden files/folders (except .env.example)
      if (name.startsWith('.') && name !== '.env.example') continue;

      if (entry.isDirectory()) {
        const fullPath = path.join(dir, name);
        // FIXED: Case-insensitive check and environment check
        if (!IGNORE_DIRS.has(lowerName) && !isEnvDir(fullPath)) {
          walk(fullPath);
        }
      } else {
        const ext = path.extname(name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext) && !isNoiseFile(path.join(dir, name))) {
          files.push(path.join(dir, name));
        }
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
  const nodes: FileNode[] = [];
  for (const filePath of files) {
    try {
      const content = readFileSafe(filePath, 20000);
      const size = fs.statSync(filePath).size;
      nodes.push({
        path: filePath,
        relativePath: path.relative(rootPath, filePath),
        imports: extractImports(content, filePath),
        size,
      });
    } catch {
      // Skip files that disappear or are temporarily locked during scanning.
    }
  }
  return nodes;
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

/** Detect the project's tech stack — searches root + one level deep for monorepos */
export function detectTechStack(rootPath: string): string[] {
  const found = new Set<string>();
  const checkPath = (p: string) => fs.existsSync(p);

  // Collect all package.json paths: root + direct subfolders (monorepo support)
  const pkgPaths: string[] = [];
  if (checkPath(path.join(rootPath, 'package.json'))) {
    pkgPaths.push(path.join(rootPath, 'package.json'));
  }
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) {
        const sub = path.join(rootPath, e.name, 'package.json');
        if (checkPath(sub)) pkgPaths.push(sub);
      }
    }
  } catch { }

  for (const pkgPath of pkgPaths) {
    found.add('Node.js / JavaScript');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      if (deps['react'] || deps['react-dom']) found.add('React');
      if (deps['next']) found.add('Next.js');
      if (deps['vue']) found.add('Vue');
      if (deps['svelte']) found.add('Svelte');
      if (deps['express']) found.add('Express');
      if (deps['fastify']) found.add('Fastify');
      if (deps['koa']) found.add('Koa');
      if (deps['nestjs'] || deps['@nestjs/core']) found.add('NestJS');
      if (deps['typescript']) found.add('TypeScript');
      if (deps['socket.io'] || deps['socket.io-client']) found.add('Socket.IO');
      if (deps['mongoose']) found.add('MongoDB / Mongoose');
      if (deps['sequelize'] || deps['typeorm']) found.add('SQL ORM');
      if (deps['prisma'] || deps['@prisma/client']) found.add('Prisma');
      if (deps['tailwindcss']) found.add('Tailwind CSS');
      if (deps['@mui/material'] || deps['antd']) found.add('UI Library');
      if (deps['redux'] || deps['@reduxjs/toolkit']) found.add('Redux');
      if (deps['vite']) found.add('Vite');
      if (deps['webpack']) found.add('Webpack');
      if (deps['jest'] || deps['vitest']) found.add('Testing');
    } catch { }
  }

  // Check root-level markers regardless
  const check = (f: string) => checkPath(path.join(rootPath, f));
  if (check('requirements.txt') || check('pyproject.toml') || check('setup.py')) found.add('Python');
  if (check('go.mod')) found.add('Go');
  if (check('Cargo.toml')) found.add('Rust');
  if (check('pom.xml') || check('build.gradle')) found.add('Java');
  if (check('Gemfile')) found.add('Ruby');
  if (check('composer.json')) found.add('PHP');
  if (check('Dockerfile') || check('docker-compose.yml') || check('docker-compose.yaml')) found.add('Docker');
  if (check('.github/workflows')) found.add('GitHub Actions');
  // Also check one level deep for Dockerfiles
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) {
        if (checkPath(path.join(rootPath, e.name, 'Dockerfile'))) found.add('Docker');
        if (checkPath(path.join(rootPath, e.name, 'requirements.txt'))) found.add('Python');
      }
    }
  } catch { }

  return Array.from(found);
}
