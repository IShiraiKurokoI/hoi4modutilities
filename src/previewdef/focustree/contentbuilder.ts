import * as vscode from 'vscode';
import { getFocusTree, FocusTree, Focus } from './schema';
import { parseHoi4File } from '../../hoiformat/hoiparser';
import { getSpriteByGfxName, Image, getImageByPath } from '../../util/image/imagecache';
import { localize } from '../../util/i18n';
import { arrayToMap } from '../../util/common';
import { GridBoxType, HOIPartial, toNumberLike, toStringAsSymbolIgnoreCase } from '../../hoiformat/schema';
import { renderGridBox, GridBoxItem, GridBoxConnection } from '../../util/hoi4gui/gridbox';
import { html, StyleTable, htmlEscape } from '../../util/html';

export const focusesGFX = 'interface/goals.gfx';
const defaultFocusIcon = 'gfx/interface/goals/goal_unknown.dds';

export async function renderFocusTreeFile(fileContent: string, uri: vscode.Uri, webview: vscode.Webview): Promise<string> {
    const styleTable = new StyleTable();
    let baseContent = '';
    try {
        const focustrees = getFocusTree(parseHoi4File(fileContent, localize('infile', 'In file {0}:\n', uri.toString())));
        if (focustrees.length > 0) {
            baseContent = await renderFocusTree(focustrees[0], styleTable);
        } else {
            baseContent = localize('focustree.nofocustree', 'No focus tree.');
        }
    } catch (e) {
        baseContent = `${localize('error', 'Error')}: <br/>  <pre>${htmlEscape(e.toString())}</pre>`;
    }

    return html(webview, baseContent, [
        { content: `window.previewedFileUri = "${uri.toString()}";` },
        'common.js',
        'focustree.js',
    ], styleTable);
}


const leftPaddingBase = 30;
const topPaddingBase = 30;
const xGridSize = 90;
const yGridSize = 120;
const optionHeight = 20;

async function renderFocusTree(focustree: FocusTree, styleTable: StyleTable): Promise<string> {
    const focuses = Object.values(focustree.focuses);
    const minX = focuses.reduce((p, c) => p > c.x ? c.x : p, 1000);
    const leftPadding = leftPaddingBase - minX * xGridSize;
    const topPadding = focustree.allowBranchOptions.length * optionHeight + topPaddingBase;

    const gridBox: HOIPartial<GridBoxType> = {
        position: { x: toNumberLike(leftPadding), y: toNumberLike(topPadding) },
        format: toStringAsSymbolIgnoreCase('up'),
        size: { width: toNumberLike(xGridSize), height: undefined },
        slotsize: { width: toNumberLike(xGridSize), height: toNumberLike(yGridSize) },
    } as HOIPartial<GridBoxType>;

    return (
        `<div id="dragger" class="${styleTable.oneTimeStyle('dragger', () => `
            width: 100vw;
            height: 100vh;
            position: fixed;
            left:0;
            top:0;
        `)}"></div>` +
        focustree.allowBranchOptions.map((option, index) => renderAllowBranchOptions(option, index, styleTable)).join('') +
        await renderGridBox(gridBox, {
            size: { width: 0, height: 0 },
            orientation: 'upper_left'
        }, {
            styleTable,
            items: arrayToMap(focuses.map(focus => focusToGridItem(focus, focustree)), 'id'),
            onRenderItem: item => renderFocus(focustree.focuses[item.id], styleTable),
            cornerPosition: 0.5,
        })
    );
}

function focusToGridItem(focus: Focus, focustree: FocusTree): GridBoxItem {
    const classNames = focus.inAllowBranch.map(v => 'inbranch_' + v).join(' ');
    const connections: GridBoxConnection[] = [];
    
    for (const prerequisites of focus.prerequisite) {
        let style: string;
        if (prerequisites.length > 1) {
            style = "1px dashed #88aaff";
        } else {
            style = "1px solid #88aaff";
        }

        prerequisites.forEach(p => {
            const fp = focustree.focuses[p];
            const classNames2 = fp?.inAllowBranch.map(v => 'inbranch_' + v).join(' ') ?? '';
            connections.push({
                target: p,
                targetType: 'parent',
                style: style,
                classNames: classNames + ' ' + classNames2,
            });
        });
    }

    focus.exclusive.forEach(e => {
        const fe = focustree.focuses[e];
        const classNames2 = fe?.inAllowBranch.map(v => 'inbranch_' + v).join(' ') ?? '';
        connections.push({
            target: e,
            targetType: 'related',
            style: "1px solid red",
            classNames: classNames + ' ' + classNames2,
        });
    });

    return {
        id: focus.id,
        htmlId: 'focus_' + focus.id,
        classNames,
        gridX: focus.x,
        gridY: focus.y,
        connections,
    };
}


function renderAllowBranchOptions(option: string, index: number, styleTable: StyleTable): string {
    return `<div class="${styleTable.oneTimeStyle('allowBranchOptions', () => `
        position: fixed;
        left: ${leftPaddingBase}px;
        top: ${10 + index * optionHeight}px;
        z-index: 100;
    `)}">
        <input type="checkbox" checked="true" id="inbranch_${option}" class="inbranch-checkbox"/>
        <label for="inbranch_${option}">${option}</label>
        <a class="gotofocus-button ${styleTable.style('displayInline', () => `display:inline;`)}" focus="focus_${option}" href="javascript:;">Goto</a>
    </div>`;
}

async function renderFocus(focus: Focus, styleTable: StyleTable): Promise<string> {
    const icon = focus.icon ? await getFocusIcon(focus.icon) : null;

    return `<div
    class="
        navigator
        ${styleTable.oneTimeStyle('focus', () => `
            ${icon ? `background-image: url(${icon?.uri});` : 'background: grey;'}
            background-size: ${icon ? icon.width: 0}px;
        `)}
        ${styleTable.style('focus-common', () => `
            background-position: center;
            background-repeat: no-repeat;
            width: 100%;
            height: 100%;
            text-align: center;
            cursor: pointer;
        `)}
    "
    start="${focus.token?.start}"
    end="${focus.token?.end}"
    title="${focus.id}\n(${focus.x}, ${focus.y})">
        <span
        class="${styleTable.style('focus-span', () => `
            margin: 10px -400px;
            text-align: center;
            display: inline-block;
        `)}">${focus.id}
        </span>
    </div>`;
}

export async function getFocusIcon(name: string): Promise<Image | undefined> {
    const sprite = await getSpriteByGfxName(name, focusesGFX);
    if (sprite !== undefined) {
        return sprite.image;
    }

    return await getImageByPath(defaultFocusIcon);
}
