import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeFile, FileAnalysis } from './analyzer/astAnalyzer';
import { buildDependencyGraph, invalidateGraph, DependencyInfo } from './analyzer/dependencyGraph';

// Extensions we can safely read as text
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs',
  '.vue', '.svelte', '.css', '.scss', '.sass', '.less',
  '.html', '.md', '.mdx', '.json', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.rb', '.swift', '.kt', '.env',
  '.txt', '.xml', '.graphql', '.sql',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv',
  'target', 'coverage', '.turbo', '.cache',
]);

// ─── Tree Item ────────────────────────────────────────────────────────────────
class FileItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    tooltip: vscode.MarkdownString | string,
    isDirectory: boolean
  ) {
    super(resourceUri, collapsibleState);
    this.tooltip = tooltip;
    this.id = resourceUri.fsPath;
    if (!isDirectory) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [resourceUri],
      };
    }
  }
}

// ─── Tree Data Provider ───────────────────────────────────────────────────────
class FileInsightProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Cache: filePath → { tooltip, file modification time }
  private tooltipCache = new Map<string, { tooltip: vscode.MarkdownString; mtime: number }>();

  // Debounce timer for file watcher
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private workspaceRoot: string) {}

  // Full refresh — clears everything and rebuilds
  refresh(): void {
    this.tooltipCache.clear();
    invalidateGraph();
    this._onDidChangeTreeData.fire();
  }

  // Partial refresh — only clears cache for one changed file, much faster
  refreshFile(filePath: string): void {
    this.tooltipCache.delete(filePath);
    invalidateGraph(); // dep graph needs rebuild since imports may have changed
    // Debounce: wait 800ms after last change before re-rendering
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this._onDidChangeTreeData.fire();
      this.refreshTimer = null;
    }, 800);
  }

  getTreeItem(element: FileItem): vscode.TreeItem { return element; }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    const dir = element ? element.resourceUri.fsPath : this.workspaceRoot;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return []; }

    // Folders first, then files, both alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const items: FileItem[] = [];

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      const uri = vscode.Uri.file(fullPath);

      if (entry.isDirectory()) {
        items.push(new FileItem(
          uri,
          vscode.TreeItemCollapsibleState.Collapsed,
          entry.name,
          true
        ));
      } else {
        const tooltip = await this.buildTooltip(fullPath);
        items.push(new FileItem(
          uri,
          vscode.TreeItemCollapsibleState.None,
          tooltip,
          false
        ));
      }
    }

    return items;
  }

  private async buildTooltip(filePath: string): Promise<vscode.MarkdownString> {
    // Skip binary files gracefully
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      const md = new vscode.MarkdownString(`📄 \`${path.basename(filePath)}\`\n\nBinary or unknown file type.`);
      md.isTrusted = true;
      return md;
    }

    try {
      const stat = fs.statSync(filePath);

      // Return cached tooltip if file hasn't changed
      const cached = this.tooltipCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.tooltip;

      // Read file once and reuse for both analysis and dep graph
      const content = fs.readFileSync(filePath, 'utf8');
      const analysis = analyzeFile(filePath, content);
      const graph = await buildDependencyGraph(this.workspaceRoot);
      const depInfo = graph.get(filePath);

      const md = buildMarkdown(filePath, analysis, depInfo);
      this.tooltipCache.set(filePath, { tooltip: md, mtime: stat.mtimeMs });
      return md;

    } catch {
      const md = new vscode.MarkdownString(`⚠️ Could not analyse \`${path.basename(filePath)}\`.`);
      md.isTrusted = true;
      return md;
    }
  }
}

// ─── Markdown Builder ─────────────────────────────────────────────────────────
function buildMarkdown(
  filePath: string,
  analysis: FileAnalysis,
  depInfo: DependencyInfo | undefined
): vscode.MarkdownString {
  const fileName = path.basename(filePath);
  const role = depInfo?.role ?? 'leaf';

  const roleMap: Record<string, string> = {
    entry:   '🚀 Entry Point — application starts here',
    core:    `🔩 Core Module — used by ${depInfo?.importedBy.length ?? 0} files`,
    utility: '🛠️ Utility / Helper — shared logic',
    config:  '⚙️ Configuration — not runtime logic',
    test:    '🧪 Test File — validates other modules',
    style:   '🎨 Stylesheet',
    leaf:    '📄 Feature Module',
  };

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────
  lines.push(`### ${analysis.languageEmoji} ${fileName}`);
  lines.push(roleMap[role] ?? '📄 Module');
  lines.push('---');

  // ── What this file does ──────────────────────────────────
  const desc = buildDescription(analysis);
  if (desc) lines.push(desc);
  lines.push('');

  // ── Exports ──────────────────────────────────────────────
  if (analysis.exports.length > 0) {
    const shown = analysis.exports.slice(0, 5);
    const extra = analysis.exports.length > 5 ? ` *+${analysis.exports.length - 5} more*` : '';
    lines.push(`**Exports** \`${shown.join('` · `')}\`${extra}`);
  }

  // ── Used by ──────────────────────────────────────────────
  if ((depInfo?.importedBy.length ?? 0) > 0) {
    const shown = depInfo!.importedBy
      .map(p => path.basename(p).replace(/\.(ts|tsx|js|jsx)$/, ''))
      .slice(0, 4);
    const extra = depInfo!.importedBy.length > 4
      ? ` *+${depInfo!.importedBy.length - 4} more*` : '';
    lines.push(`**Used by** \`${shown.join('` · `')}\`${extra}`);
  }

  // ── Depends on ───────────────────────────────────────────
  if ((depInfo?.imports.length ?? 0) > 0) {
    const shown = depInfo!.imports
      .map(p => path.basename(p).replace(/\.(ts|tsx|js|jsx)$/, ''))
      .slice(0, 4);
    const extra = depInfo!.imports.length > 4
      ? ` *+${depInfo!.imports.length - 4} more*` : '';
    lines.push(`**Depends on** \`${shown.join('` · `')}\`${extra}`);
  }

  lines.push('');

  // ── Metrics ──────────────────────────────────────────────
  const cx = analysis.complexity <= 3  ? '🟢 Low'
    : analysis.complexity <= 12 ? '🟡 Medium'
    : analysis.complexity <= 25 ? '🟠 High'
    : '🔴 Very High';

  lines.push(
    `📊 \`${analysis.linesOfCode} LOC\` · \`${analysis.totalLines} total\` · \`${analysis.commentLines} comments\` · Complexity: ${cx}`
  );

  if (analysis.todos > 0) {
    lines.push(`⚠️ ${analysis.todos} TODO/FIXME found`);
  }

  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = true;
  return md;
}

function buildDescription(analysis: FileAnalysis): string {
  if (analysis.isConfig)   return '*Project configuration — not part of runtime logic.*';
  if (analysis.isTest)     return '*Test suite — validates other modules.*';
  if (analysis.isMarkdown) return '*Documentation file.*';
  if (analysis.isStyle)    return '*Stylesheet — defines visual rules.*';
  if (analysis.isEntryPoint) return '*Application entry point — boots everything up.*';
  if (analysis.classes.length > 0 && analysis.functions.length > 0)
    return `*Defines \`${analysis.classes.join('`, `')}\` with ${analysis.functions.length} method${analysis.functions.length > 1 ? 's' : ''}.*`;
  if (analysis.classes.length > 0)
    return `*Defines: \`${analysis.classes.join('`, `')}\`*`;
  if (analysis.functions.length > 0)
    return `*Exposes: \`${analysis.functions.slice(0, 4).join('`, `')}\`*`;
  if (analysis.hasDefaultExport)
    return '*Has a default export — likely a component or handler.*';
  return '';
}

// ─── Activate ─────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('FileInsight: No workspace folder found.');
    return;
  }

  const provider = new FileInsightProvider(workspaceRoot);

  const treeView = vscode.window.createTreeView('fileInsight.explorerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Watch only source files — avoids triggering on build artifacts
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,vue,svelte,css,scss,md,json}'
  );

  // New/deleted files: full refresh
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());

  // Changed files: smart partial refresh — not a full wipe
  watcher.onDidChange((uri) => provider.refreshFile(uri.fsPath));

  const refreshCmd = vscode.commands.registerCommand('fileInsight.refresh', () => {
    provider.refresh();
    vscode.window.showInformationMessage('FileInsight: Refreshed ✅');
  });

  const toggleCmd = vscode.commands.registerCommand('fileInsight.toggle', async () => {
    const config = vscode.workspace.getConfiguration('fileInsight');
    const current = config.get<boolean>('enabled', true);
    await config.update('enabled', !current, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `FileInsight ${!current ? 'enabled ✅' : 'disabled ⏸️'}`
    );
  });

  context.subscriptions.push(treeView, watcher, refreshCmd, toggleCmd);
}

export function deactivate() {}