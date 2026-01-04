import * as vscode from 'vscode';
import * as path from 'path';
import { PromiseCache } from './cache';
import { localize } from './i18n';
import { convertNodeToJson, forEachNodeValue, HOIPartial, SchemaDef } from '../hoiformat/schema';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { Logger } from './logger';
import { basename, fileOrUriStringToUri, getConfiguration, getLastModifiedAsync, isDirectory, isFile, readDir, readFile, uriToFilePathWhenPossible } from './vsccommon';
import { workspaceModFilesCache } from './modfile';
import { Commands } from '../constants';

export interface ParsedModDescriptor {
    name?: string;
    path?: string;
    remote_file_id?: string;
    dependencies?: string[];
    replace_path?: string[];
}

export interface ModLayer {
    descriptor: vscode.Uri;
    descriptorMod?: vscode.Uri;
    name?: string;
    remoteFileId?: string;
    root: vscode.Uri;
    dependencies: string[];
    replacePaths: string[];
}

const modDescriptorBaseSchema: SchemaDef<Pick<ParsedModDescriptor, 'name' | 'path' | 'remote_file_id'>> = {
    name: 'string',
    path: 'string',
    remote_file_id: 'string',
};

function normalizeDependencyKey(value: string): string {
    return value.trim().toLowerCase();
}

function isModDepsDebugEnabled(): boolean {
    if (process.env.NODE_ENV !== 'production') {
        return true;
    }

    const conf = getConfiguration();
    return Array.isArray(conf.featureFlags) && conf.featureFlags.includes('moddepsDebug');
}

function modDepsDebug(message: string): void {
    if (isModDepsDebugEnabled()) {
        Logger.debug(`[moddeps] ${message}`);
    }
}

function isAllDigits(value: string): boolean {
    return /^[0-9]+$/.test(value.trim());
}

function defaultHoi4UserDirFsPath(): string | undefined {
    // Node `os.homedir()` is not available in the web extension bundle.
    // For desktop usage, environment variables are reliable enough.
    const home = (process.env.USERPROFILE ?? process.env.HOME ?? '').trim();
    if (home === '') {
        return undefined;
    }
    return path.join(home, 'Documents', 'Paradox Interactive', 'Hearts of Iron IV');
}

function resolveHoi4UserModDirectory(): vscode.Uri | undefined {
    const conf = getConfiguration();
    const configured = (conf.userModDirectory as string | undefined)?.trim() ?? '';
    if (configured !== '') {
        const uri = fileOrUriStringToUri(configured);
        if (uri) {
            modDepsDebug(`Using configured userModDirectory: ${uri.toString()}`);
            return uri;
        }

        modDepsDebug(`Configured userModDirectory is invalid: ${configured}`);
    }

    const defaultUserDir = defaultHoi4UserDirFsPath();
    if (!defaultUserDir) {
        modDepsDebug('Cannot infer HOI4 user directory (no USERPROFILE/HOME).');
        return undefined;
    }

    const defaultModDir = vscode.Uri.file(path.join(defaultUserDir, 'mod'));
    modDepsDebug(`Using default user mod directory: ${defaultModDir.fsPath}`);
    return defaultModDir;
}

function resolveModRootFromPathValue(pathValue: string, modIndexDirectory: vscode.Uri): vscode.Uri {
    const normalized = pathValue.replace(/\\/g, '/');

    // If path is like "mod/<folder>", it is relative to HOI4 user dir (parent of mod index directory).
    if (normalized.startsWith('mod/')) {
        const hoi4UserDir = vscode.Uri.file(path.dirname(modIndexDirectory.fsPath));
        return vscode.Uri.file(path.resolve(hoi4UserDir.fsPath, normalized));
    }

    // If it looks like an absolute path, keep it.
    if (path.isAbsolute(pathValue) || /^[a-zA-Z]:[\\/]/.test(pathValue) || normalized.startsWith('/')) {
        return vscode.Uri.file(path.normalize(pathValue));
    }

    // Otherwise treat it as relative to HOI4 user dir.
    const hoi4UserDir = vscode.Uri.file(path.dirname(modIndexDirectory.fsPath));
    return vscode.Uri.file(path.resolve(hoi4UserDir.fsPath, pathValue));
}

async function parseDescriptorFile(uri: vscode.Uri): Promise<HOIPartial<ParsedModDescriptor>> {
    const content = (await readFile(uri)).toString();
    const root = parseHoi4File(content, localize('infile', 'In file {0}:\n', uriToFilePathWhenPossible(uri)));

    // Important: HOI4 mod descriptors commonly use list blocks like:
    //   dependencies={ "123" "456" }
    // Those entries are NOT parsed as repeated "dependencies = ..." nodes, so schema "array" won't work.
    const base = convertNodeToJson<Pick<ParsedModDescriptor, 'name' | 'path' | 'remote_file_id'>>(root, modDescriptorBaseSchema);

    return {
        ...base,
        dependencies: extractStringListProperty(root, 'dependencies'),
        replace_path: extractStringListProperty(root, 'replace_path'),
    };
}

function stripQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.substring(1, trimmed.length - 1);
    }
    return trimmed;
}

function extractStringListProperty(root: any, propertyName: string): string[] {
    const results: string[] = [];
    const wanted = propertyName.toLowerCase();

    forEachNodeValue(root, (child) => {
        const childName = typeof child.name === 'string' ? child.name.toLowerCase() : '';
        if (childName !== wanted) {
            return;
        }

        // Case 1: dependencies={ "a" "b" }
        if (Array.isArray(child.value)) {
            forEachNodeValue(child, (entry) => {
                if (typeof entry.name === 'string' && entry.name.trim() !== '') {
                    results.push(stripQuotes(entry.name));
                }
            });
            return;
        }

        // Case 2: dependencies = "a" (rare, but accept)
        const asString = convertNodeToJson(child, 'string');
        if (typeof asString === 'string' && asString.trim() !== '') {
            results.push(asString.trim());
        }
    });

    return uniqueStrings(results);
}

function toStringArray(values: (string | undefined)[] | undefined): string[] {
    return (values ?? []).filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => v.length > 0);
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const v of values) {
        if (!seen.has(v)) {
            seen.add(v);
            result.push(v);
        }
    }
    return result;
}

async function resolveWorkingModFileUri(): Promise<vscode.Uri | undefined> {
    const conf = getConfiguration();
    let modFile = fileOrUriStringToUri(conf.modFile);

    if ((conf.modFile as string) === '') {
        if (vscode.workspace.workspaceFolders) {
            for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                const workspaceFolderPath = workspaceFolder.uri;
                const mods = await workspaceModFilesCache.get(workspaceFolderPath.toString());
                if (mods.length > 0) {
                    modFile = mods[0];
                    break;
                }
            }
        }
    }

    if (modFile && await isFile(modFile)) {
        return modFile;
    }

    return undefined;
}

const modIndexCache = new PromiseCache({
    factory: async (key: string) => {
        const modIndexDirectory = vscode.Uri.parse(key);
        modDepsDebug(`Scanning mod index directory: ${uriToFilePathWhenPossible(modIndexDirectory)}`);
        if (!await isDirectory(modIndexDirectory)) {
            modDepsDebug('Mod index directory missing or not a directory.');
            return [] as ModLayer[];
        }

        const files = (await readDir(modIndexDirectory)).filter(f => f.toLowerCase().endsWith('.mod'));
        modDepsDebug(`Found ${files.length} .mod index files.`);
        const result: ModLayer[] = [];
        for (const fileName of files) {
            const descriptor = vscode.Uri.joinPath(modIndexDirectory, fileName);
            try {
                if (!await isFile(descriptor)) {
                    continue;
                }
                const parsed = await parseDescriptorFile(descriptor);
                modDepsDebug(`Parsed .mod index: ${uriToFilePathWhenPossible(descriptor)} name=${String(parsed?.name)} id=${String(parsed?.remote_file_id)} path=${String(parsed?.path)}`);
                const rootPath = typeof parsed.path === 'string' ? parsed.path : undefined;
                if (!rootPath) {
                    modDepsDebug(`Skip .mod without path=: ${uriToFilePathWhenPossible(descriptor)}`);
                    continue;
                }

                const root = resolveModRootFromPathValue(rootPath, modIndexDirectory);

                // Some mods define dependencies/replace_path in root/descriptor.mod instead of the index file.
                let folderParsed: HOIPartial<ParsedModDescriptor> | undefined;
                let folderDescriptorUri: vscode.Uri | undefined;
                try {
                    const folderDescriptor = vscode.Uri.joinPath(root, 'descriptor.mod');
                    if (await isFile(folderDescriptor)) {
                        folderDescriptorUri = folderDescriptor;
                        folderParsed = await parseDescriptorFile(folderDescriptor);
                    }
                } catch (e) {
                    // ignore
                }

                const layer: ModLayer = {
                    descriptor,
                    descriptorMod: folderDescriptorUri,
                    name: (typeof folderParsed?.name === 'string' ? folderParsed?.name : undefined) ?? (typeof parsed.name === 'string' ? parsed.name : undefined),
                    remoteFileId: (typeof folderParsed?.remote_file_id === 'string' ? folderParsed?.remote_file_id : undefined) ?? (typeof parsed.remote_file_id === 'string' ? parsed.remote_file_id : undefined),
                    root,
                    dependencies: uniqueStrings([
                        ...toStringArray(parsed.dependencies as any),
                        ...toStringArray(folderParsed?.dependencies as any),
                    ]),
                    replacePaths: uniqueStrings([
                        ...toStringArray(parsed.replace_path as any),
                        ...toStringArray(folderParsed?.replace_path as any),
                    ]),
                };
                modDepsDebug(`Indexed layer: ${layer.name ?? basename(descriptor)} | root=${uriToFilePathWhenPossible(root)} deps=${layer.dependencies.length} replace_paths=${layer.replacePaths.length}`);
                result.push(layer);
            } catch (e) {
                Logger.warn(`Failed to parse mod index file: ${uriToFilePathWhenPossible(descriptor)} (${String(e)})`);
            }
        }

        return result;
    },
    life: 60 * 1000,
});

async function getAllIndexedMods(): Promise<ModLayer[]> {
    const modIndexDirectory = resolveHoi4UserModDirectory();
    if (!modIndexDirectory) {
        // Web extension (or environment without a home directory) can't infer the default HOI4 user folder.
        // Users can still set `hoi4ModUtilities.userModDirectory` explicitly.
        modDepsDebug('No mod index directory resolved; returning empty mod index list.');
        return [];
    }
    if (modIndexDirectory.scheme !== 'file') {
        modDepsDebug(`Mod index directory is not file-scheme: ${modIndexDirectory.toString()}`);
        return [];
    }
    return await modIndexCache.get(modIndexDirectory.toString());
}

function indexMods(mods: ModLayer[]): {
    byRemoteId: Map<string, ModLayer>;
    byName: Map<string, ModLayer>;
} {
    const byRemoteId = new Map<string, ModLayer>();
    const byName = new Map<string, ModLayer>();

    for (const mod of mods) {
        if (mod.remoteFileId) {
            byRemoteId.set(mod.remoteFileId.trim(), mod);
        }
        if (mod.name) {
            byName.set(normalizeDependencyKey(mod.name), mod);
        }
    }

    return { byRemoteId, byName };
}

function resolveDependency(dep: string, index: { byRemoteId: Map<string, ModLayer>; byName: Map<string, ModLayer> }): ModLayer | undefined {
    const trimmed = dep.trim();
    if (trimmed === '') {
        return undefined;
    }

    if (isAllDigits(trimmed)) {
        return index.byRemoteId.get(trimmed);
    }

    const byName = index.byName.get(normalizeDependencyKey(trimmed));
    if (byName) {
        return byName;
    }

    return undefined;
}

export interface ModDependencyResolution {
    workingModFile?: vscode.Uri;
    workingModName?: string;
    workingModRoot?: vscode.Uri;
    workingDescriptorModFile?: vscode.Uri;
    dependencyLoadOrder: ModLayer[];
    dependencyTree: {
        mod?: ModLayer;
        dependencies: ModDependencyResolution['dependencyTree'][];
        unresolved: string[];
    };
    unresolved: string[];
}

export async function resolveDependenciesForWorkingMod(): Promise<ModDependencyResolution> {
    const workingModFile = await resolveWorkingModFileUri();
    if (!workingModFile) {
        modDepsDebug('No working mod file resolved (hoi4ModUtilities.modFile empty and no .mod in workspace).');
        return {
            workingModFile: undefined,
            workingModName: undefined,
            workingModRoot: undefined,
            workingDescriptorModFile: undefined,
            dependencyLoadOrder: [],
            dependencyTree: { mod: undefined, dependencies: [], unresolved: [] },
            unresolved: [],
        };
    }

    modDepsDebug(`Working mod file: ${uriToFilePathWhenPossible(workingModFile)}`);

    let workingParsed: HOIPartial<ParsedModDescriptor> | undefined;
    try {
        workingParsed = await parseDescriptorFile(workingModFile);
        modDepsDebug(`Working parsed: name=${String(workingParsed?.name)} id=${String(workingParsed?.remote_file_id)} deps=${toStringArray(workingParsed?.dependencies as any).length}`);
    } catch (e) {
        Logger.warn(`Failed to parse working mod file: ${uriToFilePathWhenPossible(workingModFile)} (${String(e)})`);
        return {
            workingModFile,
            workingModName: undefined,
            workingModRoot: undefined,
            workingDescriptorModFile: undefined,
            dependencyLoadOrder: [],
            dependencyTree: { mod: undefined, dependencies: [], unresolved: [] },
            unresolved: [],
        };
    }

    // Many mods declare dependencies/replace_path in <modRoot>/descriptor.mod.
    let workingFolderParsed: HOIPartial<ParsedModDescriptor> | undefined;
    let workingDescriptorModFile: vscode.Uri | undefined;
    let workingModRoot: vscode.Uri | undefined;
    try {
        const modRoot = vscode.Uri.file(path.dirname(workingModFile.fsPath));
        workingModRoot = modRoot;
        const folderDescriptor = vscode.Uri.joinPath(modRoot, 'descriptor.mod');
        if (await isFile(folderDescriptor)) {
            workingDescriptorModFile = folderDescriptor;
            workingFolderParsed = await parseDescriptorFile(folderDescriptor);
            modDepsDebug(
                `Working folder descriptor.mod: ${uriToFilePathWhenPossible(folderDescriptor)} deps=${toStringArray(workingFolderParsed?.dependencies as any).length} replace_paths=${toStringArray(workingFolderParsed?.replace_path as any).length}`
            );
        } else {
            modDepsDebug('No descriptor.mod found next to working mod file.');
        }
    } catch (e) {
        modDepsDebug(`Failed to parse working folder descriptor.mod (ignored): ${String(e)}`);
    }

    const allMods = await getAllIndexedMods();
    const index = indexMods(allMods);
    modDepsDebug(`Index built: mods=${allMods.length} byName=${index.byName.size} byId=${index.byRemoteId.size}`);

    const rootDependencies = uniqueStrings([
        ...toStringArray(workingParsed.dependencies as any),
        ...toStringArray(workingFolderParsed?.dependencies as any),
    ]);
    modDepsDebug(`Root dependencies (${rootDependencies.length}): ${rootDependencies.join(' | ')}`);

    const loadOrder: ModLayer[] = [];
    const permanentlyVisited = new Set<string>();
    const temporarilyVisited = new Set<string>();
    const unresolved = new Set<string>();

    const keyOf = (m: ModLayer) => m.remoteFileId ? `id:${m.remoteFileId}` : `file:${m.descriptor.toString()}`;

    const dfs = async (mod: ModLayer): Promise<void> => {
        const k = keyOf(mod);
        if (permanentlyVisited.has(k)) {
            return;
        }
        if (temporarilyVisited.has(k)) {
            Logger.warn(`Circular mod dependency detected at ${mod.name ?? basename(mod.descriptor)}.`);
            return;
        }

        temporarilyVisited.add(k);

        for (const dep of mod.dependencies) {
            const resolved = resolveDependency(dep, index);
            if (!resolved) {
                modDepsDebug(`Unresolved dependency: "${dep}" (from ${mod.name ?? basename(mod.descriptor)})`);
                unresolved.add(dep);
                continue;
            }
            await dfs(resolved);
        }

        temporarilyVisited.delete(k);
        permanentlyVisited.add(k);

        // Only keep mods whose root exists.
        if (await isDirectory(mod.root)) {
            loadOrder.push(mod);
        } else {
            Logger.warn(`Mod path not found on disk: ${uriToFilePathWhenPossible(mod.root)} (${mod.name ?? basename(mod.descriptor)})`);
        }
    };

    const buildTree = async (deps: string[], stack: Set<string>): Promise<ModDependencyResolution['dependencyTree']> => {
        const unresolvedHere: string[] = [];
        const children: ModDependencyResolution['dependencyTree'][] = [];

        for (const dep of deps) {
            const resolved = resolveDependency(dep, index);
            if (!resolved) {
                unresolvedHere.push(dep);
                unresolved.add(dep);
                continue;
            }

            const k = keyOf(resolved);
            if (stack.has(k)) {
                unresolvedHere.push(dep);
                continue;
            }

            stack.add(k);
            const child = await buildTree(resolved.dependencies, stack);
            stack.delete(k);

            children.push({ mod: resolved, dependencies: child.dependencies, unresolved: child.unresolved });
        }

        return { mod: undefined, dependencies: children, unresolved: uniqueStrings(unresolvedHere) };
    };

    for (const dep of rootDependencies) {
        const resolved = resolveDependency(dep, index);
        if (!resolved) {
            modDepsDebug(`Unresolved root dependency: "${dep}"`);
            unresolved.add(dep);
            continue;
        }
        await dfs(resolved);
    }

    const tree = await buildTree(rootDependencies, new Set<string>());

    return {
        workingModFile,
        workingModName: (typeof workingFolderParsed?.name === 'string' ? workingFolderParsed?.name : undefined) ?? (typeof workingParsed?.name === 'string' ? workingParsed?.name : undefined),
        workingModRoot,
        workingDescriptorModFile,
        dependencyLoadOrder: loadOrder,
        dependencyTree: tree,
        unresolved: Array.from(unresolved),
    };
}

const workingReplacePathsCache = new PromiseCache({
    factory: async (key: string) => {
        if (key === 'none') {
            return [] as string[];
        }
        try {
            const uri = vscode.Uri.parse(key);
            const parsed = await parseDescriptorFile(uri);

            // Also merge replace_path from <modRoot>/descriptor.mod when present.
            let folderParsed: HOIPartial<ParsedModDescriptor> | undefined;
            try {
                if (uri.scheme === 'file') {
                    const modRoot = vscode.Uri.file(path.dirname(uri.fsPath));
                    const folderDescriptor = vscode.Uri.joinPath(modRoot, 'descriptor.mod');
                    if (await isFile(folderDescriptor)) {
                        folderParsed = await parseDescriptorFile(folderDescriptor);
                    }
                }
            } catch {
                // ignore
            }

            return uniqueStrings([
                ...toStringArray(parsed.replace_path as any),
                ...toStringArray(folderParsed?.replace_path as any),
            ]);
        } catch {
            return [] as string[];
        }
    },
    expireWhenChange: async (key: string) => {
        if (key === 'none') {
            return 0;
        }
        try {
            return await getLastModifiedAsync(vscode.Uri.parse(key));
        } catch {
            return Date.now();
        }
    },
    life: 5 * 1000,
});

export async function getWorkingModReplacePaths(): Promise<string[]> {
    const workingModFile = await resolveWorkingModFileUri();
    const key = workingModFile ? workingModFile.toString() : 'none';
    return await workingReplacePathsCache.get(key);
}

export function formatDependencyTree(resolution: ModDependencyResolution): string {
    const lines: string[] = [];

    const root = resolution.workingModFile ? basename(resolution.workingModFile) : '(No mod descriptor)';
    lines.push(`Working mod: ${root}`);

    if (resolution.unresolved.length > 0) {
        lines.push(`Unresolved dependencies (${resolution.unresolved.length}): ${resolution.unresolved.join(', ')}`);
    }

    const printNode = (node: ModDependencyResolution['dependencyTree'], indent: string) => {
        for (const child of node.dependencies) {
            const label = child.mod ? (child.mod.name ? `${child.mod.name} (${child.mod.remoteFileId ?? basename(child.mod.descriptor)})` : (child.mod.remoteFileId ?? basename(child.mod.descriptor))) : '(unknown)';
            lines.push(`${indent}- ${label}`);
            if (child.unresolved.length > 0) {
                lines.push(`${indent}  ! unresolved: ${child.unresolved.join(', ')}`);
            }
            printNode(child, indent + '  ');
        }
    };

    lines.push('Dependency tree:');
    printNode(resolution.dependencyTree, '');

    lines.push('Dependency load order (low -> high priority):');
    for (const mod of resolution.dependencyLoadOrder) {
        lines.push(`- ${mod.name ?? basename(mod.descriptor)} -> ${uriToFilePathWhenPossible(mod.root)}`);
    }

    return lines.join('\n');
}

export async function getDependencyLayersHighToLowPriority(): Promise<ModLayer[]> {
    const workingModFile = await resolveWorkingModFileUri();
    const cacheKey = workingModFile ? workingModFile.toString() : 'none';
    return await dependencyLayersCache.get(cacheKey);
}

const dependencyLayersCache = new PromiseCache({
    factory: async (key: string) => {
        if (key === 'none') {
            return [] as ModLayer[];
        }

        const resolution = await resolveDependenciesForWorkingMod();
        // loadOrder is low -> high. Convert to high -> low for file searching.
        return [...resolution.dependencyLoadOrder].reverse();
    },
    expireWhenChange: async (key: string) => {
        if (key === 'none') {
            return 0;
        }
        try {
            return await getLastModifiedAsync(vscode.Uri.parse(key));
        } catch {
            return Date.now();
        }
    },
    life: 5 * 1000,
});

export function clearModIndexCache(): void {
    modIndexCache.clear();
}

export function registerModDependencyTreeCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(Commands.ShowModDependencyTree, async () => {
        const resolution = await resolveDependenciesForWorkingMod();
        if (!resolution.workingModFile) {
            vscode.window.showWarningMessage(localize('moddeps.nomodfile', 'No working mod descriptor selected.'));
            return;
        }

        Logger.info(formatDependencyTree(resolution));
        Logger.show();
    });
}
