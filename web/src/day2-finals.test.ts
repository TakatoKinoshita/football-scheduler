import { describe, expect, it } from "vitest";

import {
  analyzeDay2FinalPlacement,
  assertNewDay2FinalPlacement,
  Day2FinalPlacementError,
} from "./day2-finals";
import type { JsonObject } from "./types";

function fixture(
  upperSection: number | undefined,
  lowerSection: number | undefined,
  laterSection: number | undefined = undefined,
  withAudit = true,
): { schedule: JsonObject; plan: JsonObject } {
  const matches: JsonObject[] = [];
  const slots: JsonObject[] = [];
  const upperMatches: JsonObject[] = [];
  const lowerMatches: JsonObject[] = [];
  if (upperSection !== undefined) {
    const match = {
      id: "UT-FINAL",
      phase: "upper_tournament",
      rank_range: [1, 2],
      final: true,
    };
    matches.push(match);
    upperMatches.push({ ...match });
    slots.push({ match_id: match.id, section_no: upperSection });
  }
  if (lowerSection !== undefined) {
    const match = {
      id: "LT-FINAL",
      phase: "lower_tournament",
      rank_range: [1, 2],
      final: true,
    };
    matches.push(match);
    lowerMatches.push({ ...match });
    slots.push({ match_id: match.id, section_no: lowerSection });
  }
  if (laterSection !== undefined) {
    const match = {
      id: "UT-PLACE3",
      phase: "upper_tournament",
      rank_range: [3, 4],
      final: false,
    };
    matches.push(match);
    upperMatches.push({ ...match });
    slots.push({ match_id: match.id, section_no: laterSection });
  }
  const usedSections = Math.max(0, ...slots.map((slot) => Number(slot.section_no)));
  const metrics: JsonObject = { used_sections: usedSections };
  if (withAudit) {
    metrics.upper_tournament_final_section = upperSection ?? null;
    metrics.lower_tournament_final_section = lowerSection ?? null;
    metrics.lower_tournament_final_section_gap = lowerSection === undefined
      ? null
      : usedSections - lowerSection;
  }
  return {
    schedule: { tournament_matches: matches, slots, metrics },
    plan: {
      upper: { participant_count: upperSection === undefined ? 1 : 2, matches: upperMatches },
      lower: { participant_count: lowerSection === undefined ? 1 : 2, matches: lowerMatches },
    },
  };
}

describe("analyzeDay2FinalPlacement", () => {
  it("recognizes finals sharing the last section", () => {
    const { schedule, plan } = fixture(5, 5);

    const analysis = analyzeDay2FinalPlacement(schedule, plan);

    expect(analysis).toMatchObject({
      usedSections: 5,
      upperFinalSection: 5,
      lowerFinalSection: 5,
      lowerFinalSectionGap: 0,
      primaryFinalIsLast: true,
      bothFinalsShareLastSection: true,
      hasFinalPlacementAudit: true,
      finalPlacementAuditMatches: true,
      legacyRuleViolation: false,
    });
  });

  it("accepts an audited lower final before the upper final", () => {
    const { schedule, plan } = fixture(5, 4);

    const analysis = assertNewDay2FinalPlacement(schedule, plan);

    expect(analysis.primaryFinalIsLast).toBe(true);
    expect(analysis.lowerFinalSectionGap).toBe(1);
  });

  it("marks an unaudited old schedule with a later match as legacy", () => {
    const { schedule, plan } = fixture(4, 4, 5, false);

    const analysis = analyzeDay2FinalPlacement(schedule, plan);

    expect(analysis.legacyRuleViolation).toBe(true);
    expect(analysis.primaryFinalIsLast).toBe(false);
  });

  it("rejects a new response whose upper final is not last", () => {
    const { schedule, plan } = fixture(4, 4, 5);

    expect(() => assertNewDay2FinalPlacement(schedule, plan)).toThrow(
      Day2FinalPlacementError,
    );
  });

  it("rejects mismatched audit values and final definitions", () => {
    const { schedule, plan } = fixture(5, 4);
    (schedule.metrics as JsonObject).lower_tournament_final_section_gap = 0;
    expect(analyzeDay2FinalPlacement(schedule, plan).finalPlacementAuditMatches).toBe(false);

    const matches = schedule.tournament_matches as JsonObject[];
    matches[0]!.rank_range = [1, 3];
    expect(() => analyzeDay2FinalPlacement(schedule, plan)).toThrow(
      Day2FinalPlacementError,
    );
  });

  it("rejects a plan whose participant count requires a missing final", () => {
    const { schedule, plan } = fixture(undefined, undefined);
    const upper = plan.upper as JsonObject;
    upper.participant_count = 2;

    expect(() => analyzeDay2FinalPlacement(schedule, plan)).toThrow(
      Day2FinalPlacementError,
    );
  });

  it("uses the lower final as the last match when no upper final exists", () => {
    const { schedule, plan } = fixture(undefined, 3);

    const analysis = assertNewDay2FinalPlacement(schedule, plan);

    expect(analysis.upperFinalSection).toBeUndefined();
    expect(analysis.lowerFinalSection).toBe(3);
    expect(analysis.primaryFinalIsLast).toBe(true);
  });
});
