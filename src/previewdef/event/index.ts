import * as vscode from 'vscode';
import { renderEventFile } from './contentbuilder';
import { matchPathEnd } from '../../util/nodecommon';
import { PreviewBase } from '../previewbase';
import { PreviewProviderDef } from '../previewmanager';
import { EventsLoader } from './loader';
import { getRelativePathInWorkspace } from '../../util/vsccommon';
import { eventTreePreview } from '../../util/featureflags';

function canPreviewEvent(document: vscode.TextDocument) {
    if (!eventTreePreview) {
        return undefined;
    }

    const uri = document.uri;
    if (matchPathEnd(uri.fsPath, ['events', '*'])) {
        return 0;
    }

    const text = document.getText();
    return /(country_event|news_event|unit_leader_event|state_event|operative_leader_event)\s*=\s*{/.exec(text)?.index;
}

const eventsGFX = 'interface/eventpictures.gfx';
class EventPreview extends PreviewBase {
    private eventsLoader: EventsLoader;
    private content: string | undefined;

    constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
        super(uri, panel);
        this.eventsLoader = new EventsLoader(getRelativePathInWorkspace(this.uri), () => Promise.resolve(this.content ?? ''));
        this.eventsLoader.onLoadDone(r => this.updateDependencies(r.dependencies));
    }

    protected async getContent(document: vscode.TextDocument): Promise<string> {
        this.content = document.getText();
        const result = await renderEventFile(this.eventsLoader, document.uri, this.panel.webview);
        this.content = undefined;
        return result;
    }
}

export const eventPreviewDef: PreviewProviderDef = {
    type: 'event',
    canPreview: canPreviewEvent,
    previewContructor: EventPreview,
};
