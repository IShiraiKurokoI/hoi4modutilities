import * as vscode from 'vscode';
import * as path from 'path';
import { PromiseCache } from '../util/cache';
import { Hoi4FsSchema } from '../constants';
import { getDependencyLayersHighToLowPriority, getWorkingModReplacePaths, resolveDependenciesForWorkingMod } from '../util/moddependencies';
import { localize } from '../util/i18n';

const VIEW_ID = 'hoi4modutilities-mergedGameFiles';

type SourceKind = 'workspace' | 'dependency' | 'vanilla';

interface SourceLayer {
    kind: SourceKind;
    label: string;
    root: vscode.Uri;
    replacePaths: string[];
}

type FileNode = {
    kind: 'file';
    relativePath: string; // folder path relative to game root, '' means root
    name: string;
    type: vscode.FileType;
    source: SourceLayer;
};

type DirNode = {
    kind: 'dir';
    relativePath: string; // folder path relative to game root, '' means root
    name: string;
    source?: SourceLayer; // first source that provides the directory
};

type PlaceholderNode = {
    kind: 'placeholder';
    name: string;
};

type Node = FileNode | DirNode | PlaceholderNode;

function normalizeRelativePath(p: string): string {
    return p.replace(/\\+/g, '/').replace(/\/\/+/, '/').replace(/^\//, '').replace(/\/$/, '');
}

function joinRelative(parent: string, child: string): string {
    const p = normalizeRelativePath(parent);
    const c = normalizeRelativePath(child);
    return p ? `${p}/${c}` : c;
}

function uriJoin(root: vscode.Uri, relativePath: string): vscode.Uri {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) {
        return root;
    }
    return vscode.Uri.joinPath(root, ...rel.split('/'));
}

function isSamePath(a: string, b: string): boolean {
    const na = normalizeRelativePath(a).toLowerCase();
    const nb = normalizeRelativePath(b).toLowerCase();
    return na === nb;
}

async function getWorkspaceSources(workingModName?: string): Promise<SourceLayer[]> {
    const replacePaths = await getWorkingModReplacePaths();

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return [];
    }

    // We treat each workspace folder as a source (higher priority). They all represent current working mod content.
    return vscode.workspace.workspaceFolders.map((f, idx) => ({
        kind: 'workspace' as const,
        label: idx === 0
            ? (workingModName ? `${workingModName} (${localize('moddeps.graph.working', 'Working mod')})` : localize('mergedfiles.source.workspace', 'Workspace'))
            : `${localize('mergedfiles.source.workspace', 'Workspace')} ${idx + 1}`,
        root: f.uri,
        replacePaths,
    }));
}

async function getDependencySources(): Promise<SourceLayer[]> {
    const deps = await getDependencyLayersHighToLowPriority();
    return deps.map((m): SourceLayer => ({
        kind: 'dependency',
        label: m.name ?? (m.remoteFileId ? `ugc_${m.remoteFileId}` : path.posix.basename(m.descriptor.path)),
        root: m.root,
        replacePaths: m.replacePaths,
    }));
}

function getVanillaSource(): SourceLayer {
    return {
        kind: 'vanilla',
        label: localize('mergedfiles.source.vanilla', 'Vanilla'),
        root: vscode.Uri.parse(`${Hoi4FsSchema}:/`),
        replacePaths: [],
    };
}

const dirEntriesCache = new PromiseCache({
    factory: async (key: string) => {
        const decoded = JSON.parse(key) as { dir: string };
        return await computeMergedDirEntries(decoded.dir);
    },
    life: 2000,
});

async function tryReadDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
        return await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return [];
    }
}

async function computeMergedDirEntries(relativeDir: string): Promise<Node[]> {
    const dir = normalizeRelativePath(relativeDir);

    const resolution = await resolveDependenciesForWorkingMod();

    const sources: SourceLayer[] = [
        ...(await getWorkspaceSources(resolution.workingModName)),
        ...(await getDependencySources()),
        getVanillaSource(),
    ];

    const replacedByHigher = new Set<string>();

    const entries = new Map<string, { type: vscode.FileType; source: SourceLayer }>();

    for (const source of sources) {
        // If any higher layer replaced this directory, lower layers are hidden.
        for (const rp of replacedByHigher) {
            if (isSamePath(dir, rp)) {
                const result: Node[] = [];
                for (const [name, v] of entries.entries()) {
                    result.push(nodeFromEntry(dir, name, v.type, v.source));
                }
                return sortNodes(result);
            }
        }

        const uri = uriJoin(source.root, dir);
        const listing = await tryReadDirectory(uri);

        for (const [name, type] of listing) {
            if (!entries.has(name)) {
                entries.set(name, { type, source });
            }
        }

        for (const rp of source.replacePaths) {
            replacedByHigher.add(rp);
        }
    }

    const result: Node[] = [];
    for (const [name, v] of entries.entries()) {
        result.push(nodeFromEntry(dir, name, v.type, v.source));
    }

    return sortNodes(result);
}

function nodeFromEntry(parentDir: string, name: string, type: vscode.FileType, source: SourceLayer): Node {
    const childRel = joinRelative(parentDir, name);
    if (type === vscode.FileType.Directory) {
        return { kind: 'dir', relativePath: childRel, name, source } satisfies DirNode;
    }

    return { kind: 'file', relativePath: childRel, name, type, source } satisfies FileNode;
}

function sortNodes(nodes: Node[]): Node[] {
    return nodes.sort((a, b) => {
        if (isPlaceholder(a) || isPlaceholder(b)) {
            return isPlaceholder(a) ? -1 : 1;
        }
        const aIsDir = isDir(a);
        const bIsDir = isDir(b);
        if (aIsDir !== bIsDir) {
            return aIsDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

function isDir(node: Node): node is DirNode {
    return (node as any).kind === 'dir';
}

function isPlaceholder(node: Node): node is PlaceholderNode {
    return (node as any).kind === 'placeholder';
}

function isFile(node: Node): node is FileNode {
    return (node as any).kind === 'file';
}

function nodeUri(node: Node): vscode.Uri {
    if (isPlaceholder(node)) {
        return getVanillaSource().root;
    }
    const sourceRoot = isDir(node) ? node.source?.root : (isFile(node) ? node.source.root : undefined);
    if (!sourceRoot) {
        // Fallback: treat as vanilla
        return uriJoin(getVanillaSource().root, (node as any).relativePath ?? '');
    }
    return uriJoin(sourceRoot, node.relativePath);
}

export class MergedGameFilesProvider implements vscode.TreeDataProvider<Node> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
    public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    public refresh(): void {
        dirEntriesCache.clear();
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getTreeItem(element: Node): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (isPlaceholder(element)) {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            return item;
        }

        if (isDir(element)) {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = element.source ? element.source.label : undefined;
            item.iconPath = vscode.ThemeIcon.Folder;
            return item;
        }

        const uri = nodeUri(element);
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.resourceUri = uri;
        item.description = isFile(element) ? element.source.label : undefined;
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [uri],
        };
        return item;
    }

    async getChildren(element?: Node): Promise<Node[]> {
        const resolution = await resolveDependenciesForWorkingMod();
        if (!resolution.workingModFile) {
            return [{ kind: 'placeholder', name: localize('moddeps.nomodfile', 'No working mod descriptor selected.') }];
        }

        if (!element) {
            // Virtual root: show main folders from merged "/".
            return await dirEntriesCache.get(JSON.stringify({ dir: '' }));
        }

        if (!isPlaceholder(element) && isDir(element)) {
            return await dirEntriesCache.get(JSON.stringify({ dir: element.relativePath }));
        }

        return [];
    }
}

export function registerMergedGameFilesView(): vscode.Disposable {
    const provider = new MergedGameFilesProvider();
    const disposables: vscode.Disposable[] = [];

    disposables.push(vscode.window.registerTreeDataProvider(VIEW_ID, provider));

    disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (
            e.affectsConfiguration('hoi4ModUtilities.modFile') ||
            e.affectsConfiguration('hoi4ModUtilities.userModDirectory') ||
            e.affectsConfiguration('hoi4ModUtilities.installPath')
        ) {
            provider.refresh();
        }
    }));

    return vscode.Disposable.from(...disposables);
}
