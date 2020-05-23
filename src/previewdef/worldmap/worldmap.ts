import * as vscode from 'vscode';
import * as path from 'path';
import worldmapview from './worldmapview.html';
import worldmapviewstyles from './worldmapview.css';
import { localize, localizeText } from '../../util/i18n';
import { html } from '../../util/html';
import { error, debug } from '../../util/debug';
import { WorldMapMessage, ProgressReporter, WorldMapData, MapItemMessage } from './definitions';
import { slice, writeFile, debounceByInput, matchPathEnd } from '../../util/common';
import { getFilePathFromMod, readFileFromModOrHOI4 } from '../../util/fileloader';
import { WorldMapLoader } from './loader/worldmaploader';
import { isEqual } from 'lodash';

export class WorldMap {
    private worldMapLoader: WorldMapLoader;
    private worldMapDependencies: string[] | undefined;
    private cachedWorldMap: WorldMapData | undefined;

    constructor(readonly panel: vscode.WebviewPanel) {
        this.worldMapLoader = new WorldMapLoader(this.progressReporter);
    }

    public initialize(): void {
        const webview = this.panel.webview;
        webview.html = localize('loading', 'Loading...');
        webview.html = this.renderWorldMap();
        webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    }

    public onDocumentChange = debounceByInput(
        (uri: vscode.Uri) => {
            if (!this.worldMapDependencies) {
                return;
            }

            if (this.worldMapDependencies.some(d => matchPathEnd(uri.fsPath, d.split('/')))) {
                this.sendProvinceMapSummaryToWebview(false);
            }
        },
        uri => uri.fsPath,
        1000,
        { trailing: true });

    private renderWorldMap(): string {
        return html(this.panel.webview, localizeText(worldmapview), ['worldmap.js'], ['common.css', 'codicon.css', { content: worldmapviewstyles }]);
    }

    private async onMessage(msg: WorldMapMessage): Promise<void> {
        try {
            debug('requestprovinces ' + JSON.stringify(msg));
            switch (msg.command) {
                case 'loaded':
                    await this.sendProvinceMapSummaryToWebview(msg.force);
                    break;
                case 'requestprovinces':
                    await this.panel.webview.postMessage({
                        command: 'provinces',
                        data: JSON.stringify(slice((await this.worldMapLoader.getWorldMap()).provinces, msg.start, msg.end)),
                        start: msg.start,
                        end: msg.end,
                    } as WorldMapMessage);
                    break;
                case 'requeststates':
                    await this.panel.webview.postMessage({
                        command: 'states',
                        data: JSON.stringify(slice((await this.worldMapLoader.getWorldMap()).states, msg.start, msg.end)),
                        start: msg.start,
                        end: msg.end,
                    } as WorldMapMessage);
                    break;
                case 'requestcountries':
                    await this.panel.webview.postMessage({
                        command: 'countries',
                        data: JSON.stringify(slice((await this.worldMapLoader.getWorldMap()).countries, msg.start, msg.end)),
                        start: msg.start,
                        end: msg.end,
                    } as WorldMapMessage);
                    break;
                case 'openstate':
                    await this.openStateFile(msg.file, msg.start, msg.end);
                    break;
            }
        } catch (e) {
            error(e);
        }
    }

    private progressReporter: ProgressReporter = async (progress: string) => {
        await this.panel.webview.postMessage({
            command: 'progress',
            data: progress,
        } as WorldMapMessage);
    };

    private async sendProvinceMapSummaryToWebview(force: boolean) {
        try {
            this.worldMapLoader.shallowForceReload();
            const oldCachedWorldMap = this.cachedWorldMap;
            const { result: worldMap, dependencies } = await this.worldMapLoader.load(force);
            this.worldMapDependencies = dependencies;
            this.cachedWorldMap = worldMap;

            if (!force && oldCachedWorldMap && await this.sendDifferences(oldCachedWorldMap, worldMap)) {
                return;
            }

            const summary = {
                ...worldMap,
                colorByPosition: undefined,
                provinces: [],
                states: [],
                countries: [],
            };
            await this.panel.webview.postMessage({
                command: 'provincemapsummary',
                data: summary,
            } as WorldMapMessage);
        } catch (e) {
            error(e);
            await this.panel.webview.postMessage({
                command: 'error',
                data: 'Failed to load world map ' + e.toString(),
            } as WorldMapMessage);
        }
    }

    private async openStateFile(stateFile: string, start: number | undefined, end: number | undefined): Promise<void> {
        const stateFilePathInMod = await getFilePathFromMod(stateFile);
        if (stateFilePathInMod !== undefined) {
            const document = vscode.workspace.textDocuments.find(d => d.uri.fsPath === stateFilePathInMod.replace('opened?', ''))
                ?? await vscode.workspace.openTextDocument(stateFilePathInMod);
            await vscode.window.showTextDocument(document, {
                selection: start !== undefined && end !== undefined ? new vscode.Range(document.positionAt(start), document.positionAt(end)) : undefined,
            });
            return;
        }
        
        if (!vscode.workspace.workspaceFolders?.length) {
            await vscode.window.showErrorMessage('Must open a folder before opening state file.');
            return;
        }

        let targetFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
        if (vscode.workspace.workspaceFolders.length >= 1) {
            const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select a folder to copy state file' });
            if (!folder) {
                return;
            }

            targetFolder = folder.uri.fsPath;
        }

        try {
            const [buffer] = await readFileFromModOrHOI4(stateFile);
            const targetPath = path.join(targetFolder, stateFile);
            await writeFile(targetPath, buffer);

            const document = await vscode.workspace.openTextDocument(targetPath);
            await vscode.window.showTextDocument(document, {
                selection: start !== undefined && end !== undefined ? new vscode.Range(document.positionAt(start), document.positionAt(end)) : undefined,
            });

        } catch (e) {
            await vscode.window.showErrorMessage('Error open state file: ' + e.toString());
        }
    }

    private async sendDifferences(cachedWorldMap: WorldMapData, worldMap: WorldMapData): Promise<boolean> {
        this.progressReporter('Comparing changes...');
        const changeMessages: WorldMapMessage[] = [];

        if ((['width', 'height', 'provincesCount', 'statesCount', 'countriesCount',
            'badProvincesCount', 'badStatesCount'] as (keyof WorldMapData)[])
            .some(k => !isEqual(cachedWorldMap[k], worldMap[k]))) {
            return false;
        }

        if (!isEqual(cachedWorldMap.warnings, worldMap.warnings)) {
            changeMessages.push({ command: 'warnings', data: JSON.stringify(worldMap.warnings), start: 0, end: 0 });
        }

        if (!isEqual(cachedWorldMap.continents, worldMap.continents)) {
            changeMessages.push({ command: 'continents', data: JSON.stringify(worldMap.continents), start: 0, end: 0 });
        }

        if (!isEqual(cachedWorldMap.terrains, worldMap.terrains)) {
            changeMessages.push({ command: 'terrains', data: JSON.stringify(worldMap.terrains), start: 0, end: 0 });
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.provinces, cachedWorldMap.provinces, 'provinces', worldMap.badProvincesCount, worldMap.provincesCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.states, cachedWorldMap.states, 'states', worldMap.badStatesCount, worldMap.statesCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.countries, cachedWorldMap.countries, 'countries', 0, worldMap.countriesCount)) {
            return false;
        }

        this.progressReporter('Applying changes...');

        for (const message of changeMessages) {
            await this.panel.webview.postMessage(message);
        }

        this.progressReporter('');
        return true;
    }

    private fillMessageForItem(
        changeMessages: WorldMapMessage[],
        list: unknown[],
        cachedList: unknown[],
        command: MapItemMessage['command'],
        listStart: number,
        listEnd: number,
    ): boolean {
        const changeMessagesCountLimit = 30;
        const messageCountLimit = 300;

        let lastDifferenceStart: number | undefined = undefined;
        for (let i = listStart; i <= listEnd; i++) {
            if (i === listEnd || isEqual(list[i], cachedList[i])) {
                if (lastDifferenceStart !== undefined) {
                    changeMessages.push({
                        command,
                        data: JSON.stringify(slice(list, lastDifferenceStart, i)),
                        start: lastDifferenceStart,
                        end: i,
                    });
                    if (changeMessages.length > changeMessagesCountLimit) {
                        return false;
                    }
                    lastDifferenceStart = undefined;
                }
            } else {
                if (lastDifferenceStart === undefined) {
                    lastDifferenceStart = i;
                } else if (i - lastDifferenceStart >= messageCountLimit) {
                    changeMessages.push({
                        command,
                        data: JSON.stringify(slice(list, lastDifferenceStart, i)),
                        start: lastDifferenceStart,
                        end: i,
                    });
                    if (changeMessages.length > changeMessagesCountLimit) {
                        return false;
                    }
                    lastDifferenceStart = i;
                }
            }
        }

        return true;
    }
}
