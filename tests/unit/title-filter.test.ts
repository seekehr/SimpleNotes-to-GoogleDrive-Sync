import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { titleMatcher } from "../../src/sync/titleFilter.js";
import { tempDir } from "../helpers/harness.js";

describe("titleMatcher", () => {
  it("matches any keyword anywhere in the title, ignoring case", () => {
    const match = titleMatcher(["[NOTE]", "[BOOK]"]);
    expect(match("[NOTE] Ideas")).toBe(true);
    expect(match("Reading list [book]")).toBe(true);
    expect(match("Notebook")).toBe(false);
    expect(match("NOTE without brackets")).toBe(false);
  });

  it("matches everything when no keywords are given", () => {
    expect(titleMatcher([])("anything")).toBe(true);
  });

  it("can be set from SNSYNC_TITLE_KEYWORDS as a comma-separated list", () => {
    const t = tempDir();
    try {
      const config = loadConfig({ env: { SNSYNC_HOME: t.dir, SNSYNC_TITLE_KEYWORDS: "[NOTE], [BOOK]" } });
      expect(config.sync.title_keywords).toEqual(["[NOTE]", "[BOOK]"]);
    } finally {
      t.cleanup();
    }
  });
});
