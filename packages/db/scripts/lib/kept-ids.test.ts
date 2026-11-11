import { describe, expect, it } from "vitest";

import { keepEarlierIds } from "./kept-ids";

const TOMATO = "6f1c2b9e-3a4d-4c5e-8f70-1a2b3c4d5e6f";
const CUCUMBER = "0b7e9c3a-5d21-4f8b-9a64-2c3d4e5f6a7b";

// New ids in order, so a test can say which one a record got.
function counter() {
  let n = 0;
  return () => `new-${++n}`;
}

describe("keepEarlierIds", () => {
  it("keeps the id the previous import gave a record; a record new in Bubble gets a new one", () => {
    const idFor = keepEarlierIds(new Map([["bubble-tomato", TOMATO], ["bubble-cucumber", CUCUMBER]]), counter());
    expect(idFor("bubble-tomato")).toEqual({ id: TOMATO });
    expect(idFor("bubble-new")).toEqual({ id: "new-1" });
    expect(idFor("bubble-cucumber")).toEqual({ id: CUCUMBER });
  });

  it("an earlier id not written as a uuid is not kept, and says so", () => {
    const idFor = keepEarlierIds(new Map([["b1", "not-an-id"], ["b2", `{${TOMATO}}`], ["b3", ""]]), counter());
    expect(idFor("b1")).toEqual({ id: "new-1", notKept: "its id from the previous import (not-an-id) is not a uuid" });
    expect(idFor("b2")).toEqual({ id: "new-2", notKept: `its id from the previous import ({${TOMATO}}) is not a uuid` });
    expect(idFor("b3").id).toBe("new-3");
  });

  it("an id two records had is kept by neither: either could be the product a copied code meant", () => {
    const idFor = keepEarlierIds(new Map([["b1", TOMATO], ["b2", TOMATO.toUpperCase()], ["b3", CUCUMBER]]), counter());
    expect(idFor("b1")).toEqual({ id: "new-1", notKept: `its id from the previous import (${TOMATO}) is shared with another record` });
    expect(idFor("b2").id).toBe("new-2");
    expect(idFor("b3")).toEqual({ id: CUCUMBER });
  });

  it("holds even when the other record is no longer in Bubble", () => {
    // b2 is gone from the export, so only b1 asks; the record still has TOMATO twice.
    const idFor = keepEarlierIds(new Map([["b1", TOMATO], ["b2", TOMATO]]), counter());
    expect(idFor("b1")).toEqual({ id: "new-1", notKept: `its id from the previous import (${TOMATO}) is shared with another record` });
  });

  it("a record planned twice keeps its id once", () => {
    const idFor = keepEarlierIds(new Map([["b1", TOMATO]]), counter());
    expect(idFor("b1")).toEqual({ id: TOMATO });
    expect(idFor("b1")).toEqual({ id: "new-1", notKept: `its id from the previous import (${TOMATO}) is shared with another record` });
  });

  it("keeps an id written in capitals, in the lower case Postgres writes", () => {
    const idFor = keepEarlierIds(new Map([["b1", TOMATO.toUpperCase()]]), counter());
    expect(idFor("b1")).toEqual({ id: TOMATO });
  });

  it("with no previous import, every record gets a new id", () => {
    const idFor = keepEarlierIds(new Map(), counter());
    expect([idFor("b1"), idFor("b2")]).toEqual([{ id: "new-1" }, { id: "new-2" }]);
  });
});
