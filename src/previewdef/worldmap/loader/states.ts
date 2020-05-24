import { State, Province, Warning, Zone, WarningSource, ProgressReporter, Region } from "../definitions";
import { CustomSymbol, Enum, SchemaDef, StringAsSymbol } from "../../../hoiformat/schema";
import { readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { error } from "../../../util/debug";
import { mergeBoundingBox, LoadResult, FolderLoader, FileLoader, mergeInLoadResult, sortItems, mergeRegions } from "./common";
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

type StateNoBoundingBox = Omit<State, keyof Region>;

type StateLoaderResult = { states: State[], badStatesCount: number };
export class StatesLoader extends FolderLoader<StateLoaderResult, StateNoBoundingBox[]> {
    constructor(private defaultMapLoader: DefaultMapLoader, progressReporter: ProgressReporter) {
        super('history/states', StateLoader, progressReporter);
    }

    public async shouldReload(): Promise<boolean> {
        return await super.shouldReload() || await this.defaultMapLoader.shouldReload();
    }

    protected async loadImpl(force: boolean): Promise<LoadResult<StateLoaderResult>> {
        await this.progressReporter(localize('worldmap.progress.loadingstates', 'Loading states...'));
        return super.loadImpl(force);
    }

    protected async mergeFiles(fileResults: LoadResult<StateNoBoundingBox[]>[], force: boolean): Promise<LoadResult<StateLoaderResult>> {
        const provinceMap = await this.defaultMapLoader.load(false);

        await this.progressReporter(localize('worldmap.progress.mapprovincestostates', 'Mapping provinces to states...'));

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
                token: state._token ?? null,
            });
        }

        return result;
    } catch (e) {
        error(e);
        return [];
    }
}

function sortStates(states: StateNoBoundingBox[], warnings: Warning[]): { sortedStates: StateNoBoundingBox[], badStateId: number } {
    const { sorted, badId } = sortItems(
        states,
        10000,
        (maxId) => { throw new Error(localize('TODO', 'Max state id is too large: {0}', maxId)); },
        (newState, existingState, badId) => warnings.push({
                source: [{ type: 'state', id: badId }],
                relatedFiles: [newState.file, existingState.file],
                text: localize('worldmap.warnings.stateidconflict', "There're more than one states using state id {0}.", newState.id),
            }),
        (startId, endId) => warnings.push({
                source: [{ type: 'state', id: startId }],
                relatedFiles: [],
                text: localize('worldmap.warnings.statenotexist', "State with id {0} doesn't exist.", startId === endId ? startId : `${startId}-${endId}`),
            }),
    );

    return {
        sortedStates: sorted,
        badStateId: badId,
    };
}

function calculateBoundingBox(noBoundingBoxState: StateNoBoundingBox, provinces: (Province | undefined | null)[], width: number, height: number, warnings: Warning[]): State {
    const provincesInState = noBoundingBoxState.provinces
        .map(p => {
            const province = provinces[p];
            if (!province) {
                warnings.push({
                    source: [{ type: 'state', id: noBoundingBoxState.id }],
                    relatedFiles: [noBoundingBoxState.file],
                    text: localize('worldmap.warnings.stateprovincenotexist', "Province {0} used in state {1} doesn't exist.", p, noBoundingBoxState.id),
                });
            }
            return province;
        })
        .filter((p): p is Province => !!p);

    let state: State;
    if (provincesInState.length > 0) {
        state = Object.assign(noBoundingBoxState, mergeRegions(provincesInState, width));
        if (state.boundingBox.w > width / 2 || state.boundingBox.h > height / 2) {
            warnings.push({
                source: [{ type: 'state', id: state.id }],
                relatedFiles: [state.file],
                text: localize('worldmap.warnings.statetoolarge', 'State {0} is too large: {1}x{2}.', state.id, state.boundingBox.w, state.boundingBox.h),
            });
        }
    } else {
        state = Object.assign(noBoundingBoxState, { boundingBox: { x: 0, y: 0, w: 0, h: 0 }, centerOfMass: { x: 0, y: 0 }, mass: 0 });
        if (noBoundingBoxState.provinces.length > 0) {
            warnings.push({
                source: [{ type: 'state', id: noBoundingBoxState.id }],
                relatedFiles: [noBoundingBoxState.file],
                text: localize('worldmap.warnings.statenovalidprovinces', "State {0} in doesn't have valid provinces.", noBoundingBoxState.id),
            });
        }
    }

    return state;
}

function validateProvinceInState(provinces: (Province | undefined | null)[], states: (State | undefined | null)[], badStatesCount: number, warnings: Warning[]) {
    const provinceToState: Record<number, number> = {};

    for (let i = badStatesCount; i < states.length; i++) {
        const state = states[i];
        if (!state) {
            continue;
        }

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
