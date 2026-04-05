import * as path from 'path';
import * as fs from 'fs';

export interface DependencyInfo {
  importedBy: string[];
  imports: string[];
  role: 'entry' | 'core' | 'utility' | 'config' | 'test' | 'style' | 'leaf';
}

let graphCache: Map<string, DependencyInfo> | null = null;
let lastRoot: string | null = null;

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', 'build',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv',
  'target', 'vendor', '.cache', 'coverage', '.turbo',
]);

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.go', '.rs', '.java', '.cs',
  '.vue', '.svelte',
]);

// Binary/non-text extensions to skip reading
const SKIP_READ_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.7z',
  '.pdf', '.exe', '.dll', '.so',
]);

export async function buildDependencyGraph(
  root: string,
  maxFiles = 1500
): Promise<Map<string, DependencyInfo>> {
  if (graphCache && lastRoot === root) return graphCache;

  const graph = new Map<string, DependencyInfo>();
  const files = getAllFiles(root, maxFiles);

  for (const f of files) {
    graph.set(f, { importedBy: [], imports: [], role: 'leaf' });
  }

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (SKIP_READ_EXTS.has(ext)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const imp of extractRelativeImports(content)) {
        const resolved = resolveImport(imp, filePath, files);
        if (resolved && resolved !== filePath) {
          const node = graph.get(filePath);
          const target = graph.get(resolved);
          if (node && !node.imports.includes(resolved)) {
            node.imports.push(resolved);
          }
          if (target && !target.importedBy.includes(filePath)) {
            target.importedBy.push(filePath);
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  for (const [fp, info] of graph) {
    info.role = computeRole(fp, info);
  }

  graphCache = graph;
  lastRoot = root;
  return graph;
}

function computeRole(fp: string, info: DependencyInfo): DependencyInfo['role'] {
  const name = path.basename(fp);
  const ext = path.extname(name).slice(1).toLowerCase(); // safe: uses path.extname

  // Test: check path pattern first
  if (
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|go|rs)$/.test(name) ||
    /[/\\](__tests__|tests?|e2e)[/\\]/.test(fp)
  ) return 'test';

  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'style';

  if (
    ['json', 'yaml', 'yml', 'toml'].includes(ext) ||
    name.startsWith('.env') ||
    name.includes('.config.')
  ) return 'config';

  if (/^(index|main|app|server|entry)\.(ts|tsx|js|jsx|py|go|rs)$/.test(name)) return 'entry';

  // Role by how many files depend on this one
  if (info.importedBy.length >= 8) return 'core';
  if (info.importedBy.length >= 3) return 'utility';
  return 'leaf';
}

function getAllFiles(root: string, max: number): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (results.length >= max) return;
      if (IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

function extractRelativeImports(content: string): string[] {
  const found: string[] = [];
  const patterns = [
    /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"](\.[^'"]+)['"]/g,
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, // dynamic imports
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(content)) !== null) {
      if (m[1]) found.push(m[1]);
    }
  }
  return found;
}

function resolveImport(imp: string, from: string, files: string[]): string | null {
  const base = path.resolve(path.dirname(from), imp);
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.jsx',
    base + '/index.ts',
    base + '/index.tsx',
    base + '/index.js',
    base + '/index.jsx',
  ];
  for (const c of candidates) {
    if (files.includes(c)) return c;
  }
  return null;
}

export function invalidateGraph(): void {
  graphCache = null;
  lastRoot = null;
}