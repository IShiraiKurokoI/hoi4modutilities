import { State, Province, Warning, Zone, WarningSource, ProgressReporter } from "../definitions";
import { CustomSymbol, Enum, SchemaDef, StringAsSymbol } from "../../../hoiformat/schema";
import { readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { error } from "../../../util/debug";
import { mergeBoundingBox, LoadResult, FolderLoader, FileLoader, mergeInLoadResult } from "./common";
import { Token } from "../../../hoiformat/hoiparser";
import { arrayToMap } from "../../../util/common";
import { DefaultMapLoader } from "./provincemap";
import { localize } from "../../../util/i18n";

interface StateFile {
    state: StateDefinition[];
}

interface StateDefinition {
	id: number;
	name: string;
	manpower: number;
	state_category: StringAsSymbol;
	history: StateHistory;
    provinces: Enum;
    impassable: boolean;
    _token: Token;
}

interface StateHistory {
    owner: CustomSymbol;
    victory_points: Enum[];
    add_core_of: CustomSymbol[];
}

const stateFileSchema: SchemaDef<StateFile> = {
    state: {
        _innerType: {
            id: "number",
            name: "string",
            manpower: "number",
            state_category: "stringassymbol",
            history: {
                owner: "symbol",
                victory_points: {
                    _innerType: "enum",
                    _type: "array",
                },
                add_core_of: {
                    _innerType: "symbol",
                    _type: "array",
                },
            },
            provinces: "enum",
            impassable: "boolean",
        },
        _type: "array",
    },
};

type StateNoBoundingBox = Omit<State, 'boundingBox'>;

type StateLoaderResult = { states: State[], badStatesCount: number };
export class StatesLoader extends FolderLoader<StateLoaderResult, StateNoBoundingBox[]> {
    constructor(private defaultMapLoader: DefaultMapLoader, progressReporter: ProgressReporter) {
        super('history/states', StateLoader, progressReporter);
    }

    protected async loadImpl(force: boolean): Promise<LoadResult<StateLoaderResult>> {
        await this.progressReporter(localize('worldmap.progress.loadingstates', 'Loading states...'));
        return super.loadImpl(force);
    }

    protected async mergeFiles(fileResults: LoadResult<StateNoBoundingBox[]>[], force: boolean): Promise<LoadResult<StateLoaderResult>> {
        await this.progressReporter(localize('worldmap.progress.mapprovincestostates', 'Map provinces to states...'));

        const provinceMap = await this.defaultMapLoader.load(false);
        const warnings = mergeInLoadResult(fileResults, 'warnings');
        const { provinces, width, height } = provinceMap.result;

        const states = fileResults.reduce<StateNoBoundingBox[]>((p, c) => p.concat(c.result), []);

        const { sortedStates, badStateId } = sortStates(states, warnings);

        const filledStates: State[] = new Array(sortedStates.length);
        for (let i = badStateId + 1; i < sortedStates.length; i++) {
            if (sortedStates[i]) {
                filledStates[i] = calculateBoundingBox(sortedStates[i], provinces, width, height, warnings);
            }
        }

        const badStatesCount = badStateId + 1;
        validateProvinceInState(provinces, filledStates, badStatesCount, warnings);

        return {
            result: {
                states: filledStates,
                badStatesCount,
            },
            dependencies: [this.folder + '/*'],
            warnings,
        };
    }
}

export class StateLoader extends FileLoader<StateNoBoundingBox[]> {
    protected loadFromFile(warnings: Warning[], force: boolean): Promise<StateNoBoundingBox[]> {
        return loadState(this.file, warnings);
    }
}

async function loadState(stateFile: string, globalWarnings: Warning[]): Promise<StateNoBoundingBox[]> {
    try {
        const data = await readFileFromModOrHOI4AsJson<StateFile>(stateFile, stateFileSchema);
        const result: StateNoBoundingBox[] = [];

        for (const state of data.state) {
            const warnings: string[] = [];
            const id = state.id ? state.id : (warnings.push(localize('worldmap.warnings.statenoid', "A state in {0} doesn't have id field.", stateFile)), -1);
            const name = state.name ? state.name : (warnings.push(localize('worldmap.warnings.statenoname', "The state doesn't have name field.")), '');
            const manpower = state.manpower ?? 0;
            const category = state.state_category?._name ? state.state_category._name : (warnings.push(localize('worldmap.warnings.statenocategory', "The state doesn't have category field.")), '');
            const owner = state.history?.owner?._name;
            const provinces = state.provinces._values.map(v => parseInt(v));
            const cores = state.history?.add_core_of.map(v => v?._name).filter((v, i, a): v is string => v !== undefined && i === a.indexOf(v)) ?? [];
            const impassable = state.impassable ?? false;
            const victoryPointsArray = state.history?.victory_points.filter(v => v._values.length >= 2).map(v => v._values.slice(0, 2).map(v => parseInt(v)) as [number, number]) ?? [];
            const victoryPoints = arrayToMap(victoryPointsArray, "0", v => v[1]);

            if (provinces.length === 0) {
                globalWarnings.push({
                    source: [{ type: 'state', id }],
                    relatedFiles: [stateFile],
                    text: localize('worldmap.warnings.statenoprovinces', "State {0} in \"{1}\" doesn't have provinces.", id, stateFile),
                });
            }

            for (const vpPair of victoryPointsArray) {
                if (!provinces.includes(vpPair[0])) {
                    warnings.push(localize('worldmap.warnings.provincenothere', 'Province {0} not included in this state. But victory points defined here.', vpPair[0]));
                }
            }

            globalWarnings.push(...warnings.map<Warning>(warning => ({
                source: [{ type: 'state', id }],
                relatedFiles: [stateFile],
                text: warning,
            })));

            result.push({
                id, name, manpower, category, owner, provinces, cores, impassable, victoryPoints,
                file: stateFile,
                token: state._token
            });
        }

        return result;
    } catch (e) {
        error(e);
        return [];
    }
}

function sortStates(states: StateNoBoundingBox[], warnings: Warning[]): { sortedStates: StateNoBoundingBox[], badStateId: number } {
    const maxStateId = states.reduce((p, c) => c.id > p ? c.id : p, 0);
    if (maxStateId > 10000) {
        throw new Error(`Max state id is too large: ${maxStateId}.`);
    }

    let badStateId = -1;
    const result: StateNoBoundingBox[] = new Array(maxStateId + 1);
    states.forEach(p => {
        if (p.id === -1) {
            p.id = badStateId--;
        }
        if (result[p.id]) {
            warnings.push({
                source: [{
                    type: 'state',
                    id: badStateId,
                }],
                relatedFiles: [p.file, result[p.id].file],
                text: localize('worldmap.warnings.stateidconflict', "There're more than one states using state id {0}.", p.id),
            });
            p.id = badStateId--;
        }
        result[p.id] = p;
    });

    let lastNotExistStateId: number | undefined = undefined;
    for (let i = 1; i <= maxStateId; i++) {
        if (result[i]) {
            if (lastNotExistStateId !== undefined) {
                warnings.push({
                    source: [{
                        type: 'state',
                        id: i,
                    }],
                    relatedFiles: [],
                    text: localize('worldmap.warnings.statenotexist', "State with id {0} doesn't exist.", lastNotExistStateId === i - 1 ? i - 1 : `${lastNotExistStateId}-${i - 1}`),
                });
                lastNotExistStateId = undefined;
            }
        } else {
            if (lastNotExistStateId === undefined) {
                lastNotExistStateId = i;
            }
        }
    };

    return {
        sortedStates: result,
        badStateId,
    };
}

function calculateBoundingBox(noBoundingBoxState: StateNoBoundingBox, provinces: (Province | undefined | null)[], width: number, height: number, warnings: Warning[]): State {
    const state = noBoundingBoxState as State;
    const zones = state.provinces
        .map(p => {
            const province = provinces[p];
            if (!province) {
                warnings.push({
                    source: [{ type: 'state', id: state.id }],
                    relatedFiles: [state.file],
                    text: localize('worldmap.warnings.stateprovincenotexist', "Province {0} used in state {1} doesn't exist.", p, state.id),
                });
            }
            return province?.boundingBox;
        })
        .filter((p): p is Zone => !!p);

    if (zones.length > 0) {
        state.boundingBox = zones.reduce((p, c) => mergeBoundingBox(p, c, width));
        if (state.boundingBox.w > width / 2 || state.boundingBox.h > height / 2) {
            warnings.push({
                source: [{ type: 'state', id: state.id }],
                relatedFiles: [state.file],
                text: localize('worldmap.warnings.statetoolarge', 'State {0} is too large: {1}x{2}.', state.id, state.boundingBox.w, state.boundingBox.h),
            });
        }
    } else {
        warnings.push({
            source: [{ type: 'state', id: state.id }],
            relatedFiles: [state.file],
            text: localize('worldmap.warnings.statenovalidprovinces', "State {0} in doesn't have valid provinces.", state.id),
        });
        state.boundingBox = { x: 0, y: 0, w: 0, h: 0 };
    }

    return state;
}

function validateProvinceInState(provinces: (Province | undefined | null)[], states: (State | undefined | null)[], badStatesCount: number, warnings: Warning[]) {
    const provinceToState: Record<number, number> = {};

    for (let i = badStatesCount; i < states.length; i++) {
        const state = states[i];
        if (state) {
            state.provinces.forEach(p => {
                const province = provinces[p];
                if (provinceToState[p] !== undefined) {
                    if (!province) {
                        return;
                    }

                    warnings.push({
                        source: [
                            ...[state.id, provinceToState[p]].map<WarningSource>(id => ({ type: 'state', id })),
                            { type: 'province', id: p, color: province.color }
                        ],
                        relatedFiles: [state.file, states[provinceToState[p]]!.file],
                        text: localize('worldmap.warnings.provinceinmultistates', 'Province {0} exists in multiple states: {1}, {2}', p, provinceToState[p], state.id),
                    });
                } else {
                    provinceToState[p] = state.id;
                }

                if (province?.type === 'sea') {
                    warnings.push({
                        source: [
                            { type: 'state', id: state.id },
                            { type: 'province', id: p, color: province.color },
                        ],
                        relatedFiles: [state.file],
                        text: localize('worldmap.warnings.statehassea', "Sea province {0} shouldn't belong to a state.", p),
                    });
                }
            });
        }
    }
}
