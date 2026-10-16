/**
 * Express 5 can represent repeated or wildcard route parameters as an array.
 * ReadyPackets endpoints only accept one opaque or validated parameter value;
 * treating an array as absent prevents parameter-confusion paths from reaching
 * authorization, database, or ticket logic.
 */
export function singleRouteParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
