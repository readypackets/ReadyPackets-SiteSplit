import { describe, expect, it } from "vitest";
import { singleRouteParam } from "../server/http/routeParam.js";

describe("singleRouteParam", () => {
  it("returns a single scalar route value", () => {
    expect(singleRouteParam("opaque-ticket_123")).toBe("opaque-ticket_123");
  });

  it("fails closed for absent and repeated route values", () => {
    expect(singleRouteParam(undefined)).toBe("");
    expect(singleRouteParam(["one", "two"])).toBe("");
  });
});
