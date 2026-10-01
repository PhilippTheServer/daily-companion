import type { components, paths } from './openapi';

type Schemas = components['schemas'];

/** Server-side context of a day. */
export type ContextOut = Schemas['ContextOut'];
/** The day view: entries, gauges and targets of one day. */
export type DayView = Schemas['DayView'];
/** Energy balance of a day. */
export type EnergyOut = Schemas['EnergyOut'];
/** Summary of one day. */
export type DaySummary = Schemas['DaySummary'];
/** A page of diary days. */
export type Diary = Schemas['Diary'];
/** One day in the diary. */
export type DiaryDay = Schemas['DiaryDay'];
/** One logged event in its current version. */
export type EventOut = Schemas['EventOut'];
/** All versions of one event. */
export type EventHistory = Schemas['EventHistory'];
/** The backend error shape {code, message, field}. */
export type ErrorBody = Schemas['ErrorBody'];
/** A food from the catalogue. */
export type FoodOut = Schemas['FoodOut'];
/** Food search results. */
export type FoodSearchOut = Schemas['FoodSearchOut'];
/** A progress gauge against a target. */
export type Gauge = Schemas['Gauge'];
/** A link between two events. */
export type LinkOut = Schemas['LinkOut'];
/** The stored profile. */
export type ProfileOut = Schemas['ProfileOut'];
/** The profile view. */
export type ProfileView = Schemas['ProfileView'];
/** A recipe. */
export type RecipeOut = Schemas['RecipeOut'];
/** A recipe in list form. */
export type RecipeSummary = Schemas['RecipeSummary'];
/** A food found at an outside service. */
export type RemoteFood = Schemas['RemoteFood'];
/** JSON Schemas of commands and payloads. */
export type SchemasOut = Schemas['SchemasOut'];
/** State of the outside sync. */
export type SyncStatusOut = Schemas['SyncStatusOut'];
/** Daily targets. */
export type TargetsOut = Schemas['TargetsOut'];
/** The kind of an event. */
export type Kind = EventOut['kind'];
/** A measurement metric, such as weight_kg. */
export type Metric = Schemas['MeasurementP']['metric'];
/** How two events are linked. */
export type Relation = LinkOut['relation'];

type Route = keyof paths;
type Json<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

/** Name of a view, derived from the generated routes. */
export type ViewName = Route extends infer R
  ? R extends `/api/v2/views/${infer V}`
    ? V
    : never
  : never;
/** Name of a command, derived from the generated routes. */
export type CommandName = Route extends infer R
  ? R extends `/api/v2/commands/${infer C}`
    ? C
    : never
  : never;

/** Query parameters of a view. */
export type ViewParams<V extends ViewName> = NonNullable<
  paths[`/api/v2/views/${V}`]['get']['parameters']['query']
>;
/** Response body of a view. */
export type ViewResult<V extends ViewName> = Json<
  paths[`/api/v2/views/${V}`]['get']['responses'][200]
>;
/** Request body of a command. */
export type CommandInput<C extends CommandName> = Json<
  NonNullable<paths[`/api/v2/commands/${C}`]['post']['requestBody']>
>;
/** Response body of a command. */
export type CommandResult<C extends CommandName> = Json<
  paths[`/api/v2/commands/${C}`]['post']['responses'][200]
>;
