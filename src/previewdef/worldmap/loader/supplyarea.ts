import { Enum, SchemaDef } from "../../../hoiformat/schema";
import { Token } from "../../../hoiformat/hoiparser";
import { FileLoader, FolderLoader, LoadResult, mergeInLoadResult, sortItems, mergeRegion } from "./common";
import { Warning, SupplyArea, Region, ProgressReporter, State, WarningSource, Province } from "../definitions";
import { readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { localize } from "../../../util/i18n";
import { error } from "../../../util/debug";
import { DefaultMapLoader } from "./provincemap";
import { StatesLoader } from "./states";

interface SupplyAreaFile {
    supply_area: SupplyAreaDefinition[];
}

interface SupplyAreaDefinition {
    id: number;
    name: string;
    value: number;
    states: Enum;
    _token: Token;
}

const supplyAreaFileSchema: SchemaDef<SupplyAreaFile> = {
    supply_area: {
        _innerType: {
            id: "number",
            name: "string",
            value: "number",
            states: "enum",
        },
        _type: "array",
    },
};

type SupplyAreasLoaderResult = { supplyAreas: SupplyArea[], badSupplyAreasCount: number };
export class SupplyAreasLoader extends FolderLoader<SupplyAreasLoaderResult, SupplyAreaNoRegion[]> {
    constructor(private defaultMapLoader: DefaultMapLoader, private statesLoader: StatesLoader, progressReporter: ProgressReporter) {
        super('map/supplyareas', SupplyAreaLoader, progressReporter);
    }

    public async shouldReloadImpl(): Promise<boolean> {
        return await super.shouldReloadImpl() || await this.defaultMapLoader.shouldReload() || await this.statesLoader.shouldReload();
    }

    protected async loadImpl(force: boolean): Promise<LoadResult<SupplyAreasLoaderResult>> {
        await this.progressReporter(localize('worldmap.progress.loadingsupplyareas', 'Loading supply areas...'));
        return super.loadImpl(force);
    }

    protected async mergeFiles(fileResults: LoadResult<SupplyAreaNoRegion[]>[], force: boolean): Promise<LoadResult<SupplyAreasLoaderResult>> {
        const provinceMap = await this.defaultMapLoader.load(false);
        const stateMap = await this.statesLoader.load(false);

        await this.progressReporter(localize('worldmap.progress.mapstatetosupplyarea', 'Mapping states to supply areas...'));

        const warnings = mergeInLoadResult(fileResults, 'warnings');
        const SupplyAreas = fileResults.reduce<SupplyAreaNoRegion[]>((p, c) => p.concat(c.result), []);

        const { width, provinces } = provinceMap.result;

        const { sortedSupplyAreas, badSupplyAreaId } = sortSupplyAreas(SupplyAreas, warnings);

        const { states } = stateMap.result;
        const badSupplyAreasCount = badSupplyAreaId + 1;

        const filledSupplyAreas: SupplyArea[] = new Array(sortedSupplyAreas.length);
        for (let i = badSupplyAreasCount; i < sortedSupplyAreas.length; i++) {
            if (sortedSupplyAreas[i]) {
                filledSupplyAreas[i] = calculateBoundingBox(sortedSupplyAreas[i], states, width, warnings);
            }
        }

        validateStatesInSupplyAreas(states, filledSupplyAreas, provinces, badSupplyAreasCount, warnings);

        return {
            result: {
                supplyAreas: filledSupplyAreas,
                badSupplyAreasCount,
            },
            dependencies: [this.folder + '/*'],
            warnings,
        };
    }

    public toString() {
        return `[SupplyAreasLoader]`;
    }
}

class SupplyAreaLoader extends FileLoader<SupplyAreaNoRegion[]> {
    protected loadFromFile(warnings: Warning[], force: boolean): Promise<SupplyAreaNoRegion[]> {
        return loadSupplyArea(this.file, warnings);
    }

    public toString() {
        return `[SupplyAreaLoader: ${this.file}]`;
    }
}

type SupplyAreaNoRegion = Omit<SupplyArea, keyof Region>;
async function loadSupplyArea(file: string, globalWarnings: Warning[]): Promise<SupplyAreaNoRegion[]> {
    const result: SupplyAreaNoRegion[] = [];
    try {
        const data = await readFileFromModOrHOI4AsJson<SupplyAreaFile>(file, supplyAreaFileSchema);
        for (const supplyArea of data.supply_area) {
            const warnings: string[] = [];
            const id = supplyArea.id ? supplyArea.id : (warnings.push(localize('worldmap.warnings.supplyareanoid', "A supply area in \"{0}\" doesn't have id field.", file)), -1);
            const name = supplyArea.name ? supplyArea.name : (warnings.push(localize('worldmap.warnings.supplyareanoname', "Supply area {0} doesn't have name field.", id)), '');
            const value = supplyArea.value ?? 0;
            const states = supplyArea.states._values.map(v => parseInt(v));

            if (states.length === 0) {
                warnings.push(localize('worldmap.warnings.supplyareanostates', "Supply area {0} in \"{1}\" doesn't have states.", id, file));
            }

            globalWarnings.push(...warnings.map<Warning>(warning => ({
                source: [{ type: 'supplyarea', id }],
                relatedFiles: [file],
                text: warning,
            })));

            result.push({
                id,
                name,
                states,
                value,
                file,
                token: supplyArea._token ?? null,
            });
        }

    } catch (e) {
        error(e);
    }

    return result;
}

function sortSupplyAreas(supplyAreas: SupplyAreaNoRegion[], warnings: Warning[]): { sortedSupplyAreas: SupplyAreaNoRegion[], badSupplyAreaId: number } {
    const { sorted, badId } = sortItems(
        supplyAreas,
        10000,
        (maxId) => { throw new Error(localize('worldmap.warnings.supplyareaidtoolarge', 'Max supply area ID is too large: {0}.', maxId)); },
        (newSupplyArea, existingSupplyArea, badId) => warnings.push({
                source: [{ type: 'supplyarea', id: badId }],
                relatedFiles: [newSupplyArea.file, existingSupplyArea.file],
                text: localize('worldmap.warnings.supplyareaidconflict', "There're more than one supply areas using ID {0}.", newSupplyArea.id),
            }),
        (startId, endId) => warnings.push({
                source: [{ type: 'supplyarea', id: startId }],
                relatedFiles: [],
                text: localize('worldmap.warnings.supplyareanotexist', "Supply area with id {0} doesn't exist.", startId === endId ? startId : `${startId}-${endId}`),
            }),
    );

    return {
        sortedSupplyAreas: sorted,
        badSupplyAreaId: badId,
    };
}

function calculateBoundingBox(supplyAreaNoRegion: SupplyAreaNoRegion, states: (State | undefined | null)[], width: number, warnings: Warning[]): SupplyArea {
    return mergeRegion(
        supplyAreaNoRegion,
        'states',
        states,
        width, 
        stateId => warnings.push({
                source: [{ type: 'supplyarea', id: supplyAreaNoRegion.id }],
                relatedFiles: [supplyAreaNoRegion.file],
                text: localize('worldmap.warnings.stateinsupplyareanotexist', "State {0} used in supply area {1} doesn't exist.", stateId, supplyAreaNoRegion.id),
            }),
        () => warnings.push({
                source: [{ type: 'supplyarea', id: supplyAreaNoRegion.id }],
                relatedFiles: [supplyAreaNoRegion.file],
                text: localize('worldmap.warnings.supplyareanovalidstates', "Supply area {0} doesn't have valid states.", supplyAreaNoRegion.id),
            }),
    );
}

function validateStatesInSupplyAreas(
    states: (State | undefined | null)[],
    supplyAreas: (SupplyArea | undefined | null)[],
    provinces: (Province | undefined | null)[],
    badSupplyAreasCount: number,
    warnings: Warning[]
) {
    const stateToSupplyArea: Record<number, number> = {};

    for (let i = badSupplyAreasCount; i < supplyAreas.length; i++) {
        const supplyArea = supplyAreas[i];
        if (!supplyArea) {
            continue;
        }

        const statesInSupplyArea = supplyArea.states.map(s => {
            const state = states[s];
            if (stateToSupplyArea[s] !== undefined) {
                if (!state) {
                    return undefined;
                }

                warnings.push({
                    source: [
                        ...[supplyArea.id, stateToSupplyArea[s]].map<WarningSource>(id => ({ type: 'supplyarea', id })),
                        { type: 'state', id: s }
                    ],
                    relatedFiles: [supplyArea.file, supplyAreas[stateToSupplyArea[s]]!.file, state.file],
                    text: localize('worldmap.warnings.stateinmultiplesupplyareas', 'State {0} exists in multiple supply areas: {1}, {2}.', s, stateToSupplyArea[s], supplyArea.id),
                });
            } else {
                stateToSupplyArea[s] = supplyArea.id;
            }

            return state;
        }).filter((s): s is State => !!s);

        const badStates = checkStatesContiguous(statesInSupplyArea, provinces);
        if (badStates) {
            warnings.push({
                source: [{ type: 'supplyarea', id: i }],
                relatedFiles: [supplyArea.file],
                text: localize('worldmap.warnings.statesnotcontiguous', 'States in supply area {0} are not contiguous: {1}, {2}.', i, badStates[0], badStates[1]),
            });
        }
    }

    for (let i = 1; i < states.length; i++) {
        const state = states[i];
        if (!state) {
            continue;
        }
        if (!(i in stateToSupplyArea)) {
            warnings.push({
                source: [{ type: 'state', id: i }],
                relatedFiles: [state.file],
                text: localize('worldmap.warnings.statenosupplyarea', 'State {0} is not in any supply area.', i),
            });
        }
    }
}

function checkStatesContiguous(states: State[], provinces: (Province | undefined | null)[]): [number, number] | undefined {
    if (states.length === 0) {
        return undefined;
    }
    
    const accessedStates: Record<number, boolean> = {};
    const stack: State[] = [states[0]];
    accessedStates[stack[0].id] = true;

    while (stack.length) {
        const currentState = stack.pop()!;
        for (const state of states) {
            if (accessedStates[state.id]) {
                continue;
            }

            if (statesAreAdjacent(state, currentState, provinces)) {
                stack.push(state);
                accessedStates[state.id] = true;
            }
        }
    }

    const accessedKeys = Object.keys(accessedStates);
    return accessedKeys.length === states.length ? undefined : [states.find(state => !accessedStates[state.id])!.id, parseInt(Object.keys(accessedStates)[0])];
}

function statesAreAdjacent(stateA: State, stateB: State, provinces: (Province | undefined | null)[]): boolean {
    return stateA.provinces.some(p =>
        provinces[p]?.edges
            .some(e => e.type !== 'impassable' && stateB.provinces.some(p2 => provinces[p2] && e.to === p2)) ?? false
        );
}
