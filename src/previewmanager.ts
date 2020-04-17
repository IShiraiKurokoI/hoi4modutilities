import * as vscode from 'vscode';
import * as path from 'path';
import { debounce } from 'lodash';
import { PreviewProviderDef } from './previewProviderDef';
import { focusTreePreviewDef } from './previewdef/focustree';
import { localize } from './util/i18n';
import { gfxPreviewDef } from './previewdef/gfx';

interface PreviewMeta {
    uri: vscode.Uri;
    panel: vscode.WebviewPanel;
    previewProvider: PreviewProviderDef;
    deboncedUpdateMethod(document: vscode.TextDocument, panel: vscode.WebviewPanel): void;
}

class PreviewManager implements vscode.WebviewPanelSerializer {
    private _previews: Record<string, PreviewMeta> = {};

    private _previewProviders: PreviewProviderDef[] = [ focusTreePreviewDef, gfxPreviewDef ];
    private _previewProvidersMap: Record<string, PreviewProviderDef> = {};

    constructor() {
        this._previewProviders.forEach(pp => {
            this._previewProvidersMap[pp.type] = pp;
        });
    }

    public showPreview(uri: vscode.Uri): Promise<void> {
        return this.showPreviewImpl(uri);
    }

	public onCloseTextDocument(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        this._previews[key]?.panel.dispose();
    }
    
	public onChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
        const document = e.document;
        const key = document.uri.toString();
        const preview = this._previews[key];
        if (preview === undefined) {
            return;
        }

        preview.deboncedUpdateMethod(document, preview.panel);
    }

    public onChangeActiveTextEditor(textEditor: vscode.TextEditor | undefined): void {
        let shouldShowPreviewButton = false;
        if (textEditor) {
            if (this.findPreviewProvider(textEditor.document)) {
                shouldShowPreviewButton = true;
            }
        }

        vscode.commands.executeCommand('setContext', 'shouldHideHoi4Preview', !shouldShowPreviewButton);
    }

    public async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
        const uriStr = state?.uri as string | undefined;
        if (!uriStr) {
            panel.dispose();
            return;
        }

        try {
            const uri = vscode.Uri.parse(uriStr, true);
            await vscode.workspace.openTextDocument(uri);
            await this.showPreviewImpl(uri, panel);
        } catch (e) {
            console.error(e);
            panel.dispose();
        }
    }

    private async showPreviewImpl(uri: vscode.Uri, panel?: vscode.WebviewPanel): Promise<void> {
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (document === undefined) {
            vscode.window.showErrorMessage(localize('preview.cantfinddoc', "Can't find opened document {0}", uri.fsPath));
            panel?.dispose();
            return;
        }

        const key = uri.toString();
        if (key in this._previews) {
            this._previews[key].panel.reveal();
            panel?.dispose();
            return;
        }

        const previewProvider = this.findPreviewProvider(document);
        if (!previewProvider) {
            vscode.window.showInformationMessage(
                localize('preview.cantpreviewfile', "Can't preview this file.\nValid types: {0}.", Object.keys(this._previewProvidersMap).join(', ')));
            panel?.dispose();
            return;
        }

		const filename = path.basename(uri.path);
		panel = panel ?? vscode.window.createWebviewPanel(
            'hoi4ftpreview',
            localize('preview.viewtitle', "HOI4: {0}", filename),
			vscode.ViewColumn.Two,
			{
                enableScripts: true
            }
        );

        this._previews[key] = {
            panel,
            uri,
            previewProvider,
            deboncedUpdateMethod: debounce((d, p) => {
                previewProvider.update(d, p);
            }, 1000, { trailing: true })
        };

        panel.onDidDispose(() => {
            const preview = this._previews[key];
            if (preview) {
                if (preview.previewProvider.dispose) {
                    preview.previewProvider.dispose(document, preview.panel);
                }

                delete this._previews[key];
            }
        });

        previewProvider.show(document, panel);
    }

    private findPreviewProvider(document: vscode.TextDocument): PreviewProviderDef | null {
        for (const provider of this._previewProviders) {
            if (provider.condition(document)) {
                return provider;
            }
        }

        return null;
    }
}

export const previewManager = new PreviewManager();
