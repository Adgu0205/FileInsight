export interface FileAnalysis {
  language: string;
  languageEmoji: string;
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  hasDefaultExport: boolean;
  isEntryPoint: boolean;
  isConfig: boolean;
  isTest: boolean;
  isStyle: boolean;
  isMarkdown: boolean;
  totalLines: number;
  linesOfCode: number;
  blankLines: number;
  commentLines: number;
  complexity: number;
  todos: number;
}

export function analyzeFile(filePath: string, content: string): FileAnalysis {
  const fileName = filePath.split('/').pop() ?? '';
  const ext = getExt(fileName);
  const lineMetrics = countLines(content, ext);

  return {
    language: detectLanguage(ext),
    languageEmoji: detectLanguageEmoji(ext),
    exports: extractExports(content),
    functions: extractFunctions(content),
    classes: extractClasses(content),
    interfaces: extractInterfaces(content),
    hasDefaultExport: /export\s+default\b/.test(content),
    isEntryPoint: isEntryPointFile(fileName),
    isConfig: isConfigFile(fileName, ext),
    isTest: isTestFile(filePath),           // path-only, no false positives
    isStyle: ['css', 'scss', 'sass', 'less'].includes(ext),
    isMarkdown: ['md', 'mdx'].includes(ext),
    totalLines: lineMetrics.total,
    linesOfCode: lineMetrics.code,
    blankLines: lineMetrics.blank,
    commentLines: lineMetrics.comment,
    complexity: estimateComplexity(content),
    todos: (content.match(/\bTODO\b|\bFIXME\b|\bHACK\b/g) ?? []).length,
  };
}

// Gets the real extension even for multi-dot names like "index.test.ts" → "ts"
function getExt(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

// ─── Accurate line counter ────────────────────────────────────────────────────
function countLines(content: string, ext: string): {
  total: number; code: number; blank: number; comment: number;
} {
  // Remove trailing newline before splitting to avoid phantom last line
  const rawLines = content.replace(/\n$/, '').split('\n');
  const total = rawLines.length;

  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlockComment = false;

  const usesSlashComments = [
    'ts', 'tsx', 'js', 'jsx', 'java', 'cs', 'cpp', 'c',
    'go', 'rs', 'swift', 'kt', 'vue', 'svelte',
  ].includes(ext);

  const usesHashComments = [
    'py', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml',
  ].includes(ext);

  for (const raw of rawLines) {
    const line = raw.trim();

    if (line === '') {
      blank++;
      continue;
    }

    if (usesSlashComments) {
      // Already inside a block comment
      if (inBlockComment) {
        comment++;
        if (line.includes('*/')) inBlockComment = false;
        continue;
      }
      // Block comment opening
      if (line.startsWith('/*') || line.startsWith('/**')) {
        comment++;
        // Single-line block comment: /* ... */ on one line
        const closedOnSameLine = line.indexOf('*/') > 1;
        if (!closedOnSameLine) inBlockComment = true;
        continue;
      }
      // JSDoc / block comment continuation
      if (line.startsWith('*')) {
        comment++;
        continue;
      }
      // Single-line comment
      if (line.startsWith('//')) {
        comment++;
        continue;
      }
    }

    if (usesHashComments && line.startsWith('#')) {
      comment++;
      continue;
    }

    code++;
  }

  return { total, code, blank, comment };
}

// ─── Language maps ────────────────────────────────────────────────────────────
function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React',
    js: 'JavaScript', jsx: 'JavaScript React',
    py: 'Python', rs: 'Rust', go: 'Go',
    java: 'Java', cs: 'C#', cpp: 'C++', c: 'C',
    json: 'JSON', yaml: 'YAML', yml: 'YAML',
    md: 'Markdown', mdx: 'MDX',
    css: 'CSS', scss: 'SCSS', html: 'HTML',
    vue: 'Vue', svelte: 'Svelte',
    sh: 'Shell', rb: 'Ruby', swift: 'Swift', kt: 'Kotlin',
    toml: 'TOML', env: 'Env',
  };
  return map[ext] ?? 'Unknown';
}

function detectLanguageEmoji(ext: string): string {
  const map: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    py: '🐍', rs: '🦀', go: '🐹', java: '☕',
    cs: '🎯', cpp: '⚙️', c: '⚙️',
    json: '📋', yaml: '📋', yml: '📋', toml: '📋',
    md: '📝', mdx: '📝',
    css: '🎨', scss: '🎨',
    html: '🌐', vue: '💚', svelte: '🔶',
    sh: '💻', rb: '💎', swift: '🍎', kt: '🟣',
  };
  return map[ext] ?? '📄';
}

// ─── Extractors ───────────────────────────────────────────────────────────────
function extractExports(content: string): string[] {
  // Strip string literals and comments first to avoid false matches
  const cleaned = stripStringsAndComments(content);
  const patterns = [
    /export\s+(?:async\s+)?(?:const|function|class|type|interface|enum|let|var)\s+(\w+)/g,
    /export\s+\{\s*([^}]+)\}/g,
  ];
  const found = new Set<string>();
  for (const p of patterns) {
    let m;
    while ((m = p.exec(cleaned)) !== null) {
      m[1].split(',').forEach(s => {
        const name = s.trim().split(/\s+as\s+|\s+/)[0].trim();
        if (name && name.length > 1 && /^\w+$/.test(name)) found.add(name);
      });
    }
  }
  return [...found].slice(0, 8);
}

function extractFunctions(content: string): string[] {
  const cleaned = stripStringsAndComments(content);
  const patterns = [
    // Named function declarations
    /(?:export\s+)?(?:async\s+)?function\s+(\w{2,})\s*[(<]/g,
    // Named arrow functions assigned to const (not just any const)
    /(?:export\s+)?const\s+(\w{2,})\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[\w<>\[\]|&]+\s*)?=>/g,
    // Python / Go / Rust
    /^def\s+(\w{2,})\s*\(/gm,
    /^func\s+(\w{2,})\s*\(/gm,
    /^fn\s+(\w{2,})\s*\(/gm,
  ];
  const found = new Set<string>();
  for (const p of patterns) {
    let m;
    while ((m = p.exec(cleaned)) !== null) {
      const name = m[1];
      // Skip common false positives
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
        found.add(name);
      }
    }
  }
  return [...found].slice(0, 8);
}

function extractClasses(content: string): string[] {
  const cleaned = stripStringsAndComments(content);
  const pattern = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  const found: string[] = [];
  let m;
  while ((m = pattern.exec(cleaned)) !== null) found.push(m[1]);
  return found;
}

function extractInterfaces(content: string): string[] {
  const cleaned = stripStringsAndComments(content);
  const pattern = /(?:export\s+)?interface\s+(\w+)/g;
  const found: string[] = [];
  let m;
  while ((m = pattern.exec(cleaned)) !== null) found.push(m[1]);
  return found.slice(0, 5);
}

// Strips string literals and single-line comments to prevent false regex matches
function stripStringsAndComments(content: string): string {
  return content
    .replace(/\/\/[^\n]*/g, '')          // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')    // block comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``'); // template literals
}

// Complexity: only count real decision points, not ones inside strings/comments
function estimateComplexity(content: string): number {
  const cleaned = stripStringsAndComments(content);
  const matches = cleaned.match(
    /\b(if|else\s+if|for|while|case|catch)\b|&&|\|\||\?\s*[^:]/g
  ) ?? [];
  return matches.length;
}

// ─── File type detectors ──────────────────────────────────────────────────────
function isEntryPointFile(name: string): boolean {
  return /^(index|main|app|server|entry|start)\.(ts|tsx|js|jsx|py|go|rs)$/.test(name);
}

function isConfigFile(name: string, ext: string): boolean {
  return (
    ['json', 'yaml', 'yml', 'toml', 'env'].includes(ext) ||
    /^(tsconfig|jsconfig|package|webpack|vite|rollup|babel|eslint|jest|vitest|tailwind|postcss|prettier|next\.config|nuxt\.config|svelte\.config)/.test(name) ||
    name === '.env' || name.startsWith('.env.') ||
    name.includes('.config.')
  );
}

// Test detection based on path only — avoids false positives from imports
function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|go|rs)$/.test(filePath) ||
    /[/\\](__tests__|tests?)[/\\]/.test(filePath) ||
    /[/\\]e2e[/\\]/.test(filePath)
  );
}