import * as vscode from 'vscode';
import * as path from 'path';
import { localize } from '../util/i18n';
import { resolveDependenciesForWorkingMod, type ModLayer } from '../util/moddependencies';
import { Hoi4FsSchema } from '../constants';
import { getConfiguration } from '../util/vsccommon';

const VIEW_ID = 'hoi4modutilities-modDependencyTree';

type GraphNode = {
    id: string;
    label: string;
    subtitle?: string;
    uri?: string;
    folderUri?: string;
    remoteFileId?: string;
    vanilla?: boolean;
    unresolved?: boolean;
};

type GraphEdge = {
    from: string;
    to: string;
};

type DepTreeNode = {
    mod?: ModLayer;
    dependencies: DepTreeNode[];
    unresolved: string[];
};

function nodeIdForMod(mod: ModLayer): string {
    return mod.remoteFileId ? `id:${mod.remoteFileId}` : `desc:${mod.descriptor.toString()}`;
}

function labelForMod(mod: ModLayer): string {
    return mod.name ?? path.posix.basename(mod.descriptor.path);
}

function buildGraphFromTree(
    working: { uri: vscode.Uri; label: string; descriptorUri?: vscode.Uri; folderUri?: vscode.Uri },
    tree: DepTreeNode,
    unresolvedGlobal: string[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const workingId = `working:${working.uri.toString()}`;
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    nodes.set(workingId, {
        id: workingId,
        label: working.label,
        subtitle: localize('moddeps.graph.working', 'Working mod'),
        uri: (working.descriptorUri ?? working.uri).toString(),
        folderUri: working.folderUri?.toString(),
    });

    const ensureModNode = (mod: ModLayer) => {
        const id = nodeIdForMod(mod);
        if (!nodes.has(id)) {
            // Open the mod "description" file (descriptor.mod) when possible.
            const fileToOpen = (mod.descriptorMod ?? mod.descriptor).toString();
            nodes.set(id, {
                id,
                label: labelForMod(mod),
                subtitle: mod.remoteFileId ? `id:${mod.remoteFileId}` : undefined,
                uri: fileToOpen,
                folderUri: mod.root.toString(),
                remoteFileId: mod.remoteFileId,
            });
        }
        return id;
    };

    const ensureUnresolved = (value: string) => {
        const id = `unresolved:${value}`;
        if (!nodes.has(id)) {
            nodes.set(id, {
                id,
                label: value,
                subtitle: localize('moddeps.view.unresolved', 'unresolved'),
                unresolved: true,
            });
        }
        return id;
    };

    const visit = (parentId: string, node: DepTreeNode) => {
        for (const child of node.dependencies) {
            if (child.mod) {
                const childId = ensureModNode(child.mod);
                edges.push({ from: parentId, to: childId });
                visit(childId, child);
            }
            for (const u of child.unresolved ?? []) {
                const uId = ensureUnresolved(u);
                edges.push({ from: parentId, to: uId });
            }
        }
    };

    // Always show vanilla/base game as a node.
    const vanillaId = 'vanilla';
    nodes.set(vanillaId, {
        id: vanillaId,
        label: localize('moddeps.graph.vanilla', 'Vanilla'),
        subtitle: localize('moddeps.graph.basegame', 'Base game'),
        uri: `${Hoi4FsSchema}:/`,
        vanilla: true,
    });

    // Root children are working mod dependencies.
    visit(workingId, tree);

    // Dependency semantics for visualization:
    // - If a mod has no deps, it depends on vanilla.
    // - If it has deps, it depends only on those deps.
    const attachVanillaForLeaves = (parentId: string, node: DepTreeNode) => {
        for (const child of node.dependencies) {
            if (child.mod) {
                const childId = nodeIdForMod(child.mod);
                const hasDeps = (child.dependencies?.length ?? 0) > 0;
                const hasUnresolved = (child.unresolved?.length ?? 0) > 0;
                if (!hasDeps && !hasUnresolved) {
                    edges.push({ from: childId, to: vanillaId });
                }
                attachVanillaForLeaves(childId, child);
            }
        }
    };

    const workingHasDeps = (tree.dependencies?.length ?? 0) > 0;
    const workingHasUnresolved = (unresolvedGlobal?.length ?? 0) > 0;
    if (!workingHasDeps && !workingHasUnresolved) {
        edges.push({ from: workingId, to: vanillaId });
    }
    attachVanillaForLeaves(workingId, tree);

    // Also show global unresolved items (if any)
    for (const u of unresolvedGlobal) {
        ensureUnresolved(u);
        edges.push({ from: workingId, to: `unresolved:${u}` });
    }

    return { nodes: Array.from(nodes.values()), edges };
}

function computeVerticalTreeLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
    const byId = new Map(nodes.map(n => [n.id, n] as const));
    const out = new Map<string, string[]>();

    for (const n of nodes) {
        out.set(n.id, []);
    }

    for (const e of edges) {
        if (!byId.has(e.from) || !byId.has(e.to)) {
            continue;
        }
        out.get(e.from)!.push(e.to);
    }

    // Pick a root (working mod preferred)
    const root = nodes.find(n => n.id.startsWith('working:'))?.id ?? nodes[0]?.id;
    if (!root) {
        return new Map();
    }

    // Deterministic child ordering: by label.
    for (const [id, children] of out.entries()) {
        children.sort((a, b) => (byId.get(a)?.label ?? '').localeCompare(byId.get(b)?.label ?? ''));
        out.set(id, children);
    }

    // Build a spanning tree (best-effort) to get a proper vertical tree layout.
    const parent = new Map<string, string>();
    const treeChildren = new Map<string, string[]>();
    const visited = new Set<string>();
    const stack: string[] = [root];

    for (const n of nodes) {
        treeChildren.set(n.id, []);
    }

    while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) {
            continue;
        }
        visited.add(id);

        for (const child of out.get(id) ?? []) {
            if (child === id) {
                continue;
            }
            if (!parent.has(child) && child !== root) {
                parent.set(child, id);
                treeChildren.get(id)!.push(child);
                stack.push(child);
            }
        }
    }

    const depth = new Map<string, number>();
    depth.set(root, 0);
    const q: string[] = [root];
    while (q.length > 0) {
        const id = q.shift()!;
        const d = depth.get(id) ?? 0;
        for (const child of treeChildren.get(id) ?? []) {
            depth.set(child, d + 1);
            q.push(child);
        }
    }

    // Assign x by leaf order (post-order). Parent is centered on children.
    const pos = new Map<string, { x: number; y: number }>();
    const nodeWidth = 320;
    const nodeHeight = 56;
    const xGap = 80;
    const yGap = 80;

    let nextX = 40;
    const assignX = (id: string): number => {
        const kids = treeChildren.get(id) ?? [];
        if (kids.length === 0) {
            const x = nextX;
            nextX += nodeWidth + xGap;
            return x;
        }
        const childXs = kids.map(assignX);
        const minX = Math.min(...childXs);
        const maxX = Math.max(...childXs);
        return minX + (maxX - minX) / 2;
    };

    assignX(root);

    // Now place nodes based on computed x and depth.
    const computedX = new Map<string, number>();
    // Re-run to fill x map.
    nextX = 40;
    const fillX = (id: string): number => {
        const kids = treeChildren.get(id) ?? [];
        if (kids.length === 0) {
            const x = nextX;
            nextX += nodeWidth + xGap;
            computedX.set(id, x);
            return x;
        }
        const childXs = kids.map(fillX);
        const minX = Math.min(...childXs);
        const maxX = Math.max(...childXs);
        const x = minX + (maxX - minX) / 2;
        computedX.set(id, x);
        return x;
    };
    fillX(root);

    for (const n of nodes) {
        const x = computedX.get(n.id) ?? 40;
        const y = (depth.get(n.id) ?? 0) * (nodeHeight + yGap) + 40;
        pos.set(n.id, { x, y });
    }

    return pos;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

export class ModDependencyGraphViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private nodeById = new Map<string, GraphNode>();

    constructor(private readonly extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'open' && typeof msg.uri === 'string') {
                const uri = vscode.Uri.parse(msg.uri);
                // If user clicks the vanilla node, prefer opening the real install folder in OS.
                if (uri.scheme === Hoi4FsSchema && uri.path === '/') {
                    const installPath = (getConfiguration().installPath as string | undefined) ?? '';
                    if (installPath.trim() !== '') {
                        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(installPath));
                        return;
                    }
                }

                await vscode.commands.executeCommand('vscode.open', uri);
            } else if (msg?.type === 'nodeAction' && typeof msg.nodeId === 'string' && typeof msg.action === 'string') {
                const node = this.nodeById.get(msg.nodeId);
                if (!node) {
                    return;
                }

                if (msg.action === 'openFile' && typeof node.uri === 'string') {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(node.uri));
                } else if (msg.action === 'openFolder' && typeof node.folderUri === 'string') {
                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.parse(node.folderUri));
                } else if (msg.action === 'openSteam' && typeof node.remoteFileId === 'string' && /^[0-9]+$/.test(node.remoteFileId)) {
                    const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${node.remoteFileId}`;
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                }
            } else if (msg?.type === 'refresh') {
                await this.update();
            }
        });

        webviewView.webview.html = this.renderHtml();
        void this.update();
    }

    public async update(): Promise<void> {
        if (!this.view) {
            return;
        }

        const res = await resolveDependenciesForWorkingMod();
        if (!res.workingModFile) {
            this.view.webview.postMessage({
                type: 'empty',
                message: localize('moddeps.nomodfile', 'No working mod descriptor selected.'),
            });
            return;
        }

        const graph = buildGraphFromTree(
            {
                uri: res.workingModFile,
                label: res.workingModName ?? path.posix.basename(res.workingModFile.path),
                descriptorUri: res.workingDescriptorModFile ?? res.workingModFile,
                folderUri: res.workingModRoot,
            },
            res.dependencyTree as unknown as DepTreeNode,
            res.unresolved,
        );
        this.nodeById = new Map(graph.nodes.map(n => [n.id, n] as const));
        const layout = computeVerticalTreeLayout(graph.nodes, graph.edges);

        this.view.webview.postMessage({
            type: 'graph',
            graph,
            layout: Array.from(layout.entries()),
        });
    }

    private renderHtml(): string {
        // No hard-coded theme colors: rely on VS Code theme vars.
        const mOpenFile = localize('moddeps.context.openModFile', 'Open mod file');
        const mOpenFolder = localize('moddeps.context.openModFolder', 'Open mod folder');
        const mOpenSteam = localize('moddeps.context.openSteamPage', 'Open Steam page');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { height: 100%; padding: 0; margin: 0; }
  body {
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .btn {
    cursor: pointer;
    user-select: none;
    padding: 4px 8px;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-radius: 4px;
  }
  .hint { opacity: 0.8; }
  .wrap { position: relative; height: calc(100% - 41px); overflow: auto; }
    svg { width: 2000px; height: 2000px; }
  .edge { stroke: var(--vscode-editor-foreground); stroke-opacity: 0.35; stroke-width: 1.5; fill: none; }
  .node rect {
    fill: var(--vscode-editor-background);
    stroke: var(--vscode-panel-border);
    stroke-width: 1;
    rx: 8;
  }
  .node.unresolved rect {
    stroke-dasharray: 5 4;
  }
  .node text.title { font-weight: 600; fill: var(--vscode-foreground); }
  .node text.sub { fill: var(--vscode-descriptionForeground); }
  .node { cursor: pointer; }
    .menu {
        position: fixed;
        z-index: 1000;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-editorWidget-border);
        color: var(--vscode-foreground);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        padding: 4px 0;
        min-width: 180px;
        display: none;
    }
    .menu-item {
        padding: 6px 10px;
        cursor: pointer;
        user-select: none;
    }
    .menu-item:hover { background: var(--vscode-list-hoverBackground); }
    .menu-item.disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="btn" id="refresh">${escapeHtml(localize('common.topbar.refresh.title', 'Refresh'))}</div>
    <div class="hint" id="status"></div>
  </div>
  <div class="wrap">
    <svg id="svg" role="img" aria-label="Dependency graph"></svg>
  </div>
    <div id="menu" class="menu" role="menu" aria-label="Node actions"></div>
<script>
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('svg');
  const status = document.getElementById('status');
    const menu = document.getElementById('menu');
    let menuNode = null;
    const MENU_OPEN_FILE = ${JSON.stringify(mOpenFile)};
    const MENU_OPEN_FOLDER = ${JSON.stringify(mOpenFolder)};
    const MENU_OPEN_STEAM = ${JSON.stringify(mOpenSteam)};
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  function clear() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function renderGraph(graph, layoutEntries) {
    clear();
        const layout = new Map(layoutEntries);

        // Fixed canvas keeps behavior predictable; avoids broken sizing that hides the graph.
        svg.setAttribute('width', '2000');
        svg.setAttribute('height', '2000');

        const NODE_W = 320;
        const NODE_H = 56;
        const PAD_X = 12;

        // Draw edges first so nodes sit on top.
        for (const e of graph.edges) {
            const a = layout.get(e.from);
            const b = layout.get(e.to);
            if (!a || !b) continue;
            const x1 = a.x + NODE_W / 2;
            const y1 = a.y + NODE_H;
            const x2 = b.x + NODE_W / 2;
            const y2 = b.y;
            const midY = (y1 + y2) / 2;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('class', 'edge');
            path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2);
            svg.appendChild(path);
        }

        for (const n of graph.nodes) {
            const p = layout.get(n.id);
            if (!p) continue;
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'node' + (n.unresolved ? ' unresolved' : ''));
            g.setAttribute('transform', 'translate(' + p.x + ', ' + p.y + ')');

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('width', String(NODE_W));
            rect.setAttribute('height', String(NODE_H));
            g.appendChild(rect);

            const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            t1.setAttribute('class', 'title');
            t1.setAttribute('x', String(PAD_X));
            t1.setAttribute('y', '22');
            t1.textContent = n.label;
            g.appendChild(t1);

            if (n.subtitle) {
                const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                t2.setAttribute('class', 'sub');
                t2.setAttribute('x', String(PAD_X));
                t2.setAttribute('y', '42');
                t2.textContent = n.subtitle;
                g.appendChild(t2);
            }

            if (n.uri) {
                g.addEventListener('click', () => vscode.postMessage({ type: 'open', uri: n.uri }));
            }

            g.addEventListener('contextmenu', (ev) => {
                ev.preventDefault();
                showMenu(ev.clientX, ev.clientY, n);
            });

            svg.appendChild(g);
        }
  }

    function hideMenu() {
        menu.style.display = 'none';
        menu.textContent = '';
        menuNode = null;
    }

    function addMenuItem(label, enabled, onClick) {
        const item = document.createElement('div');
        item.className = 'menu-item' + (enabled ? '' : ' disabled');
        item.textContent = label;
        if (enabled) {
            item.addEventListener('click', () => {
                hideMenu();
                onClick();
            });
        }
        menu.appendChild(item);
    }

    function showMenu(x, y, node) {
        hideMenu();
        menuNode = node;

        // Vanilla is not a mod; do not show mod actions.
        if (node.vanilla) {
            return;
        }

        const canOpenFile = !!node.uri;
        const canOpenFolder = !!node.folderUri;
        const canOpenSteam = !!node.remoteFileId && /^[0-9]+$/.test(node.remoteFileId);

        addMenuItem(MENU_OPEN_FILE, canOpenFile, () => vscode.postMessage({ type: 'nodeAction', action: 'openFile', nodeId: node.id }));
        addMenuItem(MENU_OPEN_FOLDER, canOpenFolder, () => vscode.postMessage({ type: 'nodeAction', action: 'openFolder', nodeId: node.id }));
        addMenuItem(MENU_OPEN_STEAM, canOpenSteam, () => vscode.postMessage({ type: 'nodeAction', action: 'openSteam', nodeId: node.id }));

        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.style.display = 'block';
    }

    window.addEventListener('click', () => hideMenu());
    window.addEventListener('scroll', () => hideMenu(), true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'empty') {
      status.textContent = msg.message;
      clear();
            hideMenu();
      return;
    }
    if (msg.type === 'graph') {
      status.textContent = '';
      renderGraph(msg.graph, msg.layout);
            hideMenu();
    }
  });
</script>
</body>
</html>`;
    }
}

export function registerModDependencyGraphView(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ModDependencyGraphViewProvider(context.extensionUri);
    const disposables: vscode.Disposable[] = [];

    disposables.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));

    disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('hoi4ModUtilities.modFile') || e.affectsConfiguration('hoi4ModUtilities.userModDirectory')) {
            void provider.update();
        }
    }));

    return vscode.Disposable.from(...disposables);
}
