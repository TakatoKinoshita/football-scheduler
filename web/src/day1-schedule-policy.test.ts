import { describe, expect, it } from "vitest";

import { day1AdjacentCourtViolations } from "./day1-schedule-policy";

const matches = [
  { id: "M1", possible_home_team_ids: ["A"], possible_away_team_ids: ["B"] },
  { id: "M2", possible_home_team_ids: ["C"], possible_away_team_ids: ["D"] },
  { id: "M3", possible_home_team_ids: ["E"], possible_away_team_ids: ["F"] },
];

describe("1日目の隣接担当コート規則", () => {
  it("試合→審判の異コート割当てを検出する", () => {
    const violations = day1AdjacentCourtViolations(matches, [
      {
        day_id: "day1",
        section_no: 1,
        court_id: "court-a",
        match_id: "M1",
      },
      {
        day_id: "day1",
        section_no: 2,
        court_id: "court-b",
        match_id: "M3",
        referee_assignment: { kind: "team", team_id: "A" },
      },
    ]);

    expect(violations).toContainEqual(expect.objectContaining({ roles: ["match", "referee"] }));
  });

  it("試合→審判→試合の後半は異なるコートでも違反にしない", () => {
    expect(day1AdjacentCourtViolations(matches, [
      { day_id: "day1", section_no: 1, court_id: "court-a", match_id: "M1" },
      {
        day_id: "day1",
        section_no: 2,
        court_id: "court-a",
        match_id: "M2",
        referee_assignment: { kind: "team", team_id: "A" },
      },
      { day_id: "day1", section_no: 3, court_id: "court-b", match_id: "M3" },
    ])).toEqual([]);
  });

  it("同一コートまたは空きセクションを挟む担当は違反にしない", () => {
    expect(day1AdjacentCourtViolations(matches, [
      {
        day_id: "day1",
        section_no: 1,
        court_id: "court-a",
        match_id: "M1",
      },
      {
        day_id: "day1",
        section_no: 2,
        court_id: "court-a",
        match_id: "M2",
        referee_assignment: { kind: "team", team_id: "A" },
      },
      {
        day_id: "day1",
        section_no: 4,
        court_id: "court-b",
        match_id: "M3",
        referee_assignment: { kind: "team", team_id: "A" },
      },
    ])).toEqual([]);
  });

  it("2日目の割当ては対象外にする", () => {
    expect(day1AdjacentCourtViolations(matches, [
      { day_id: "day2", section_no: 1, court_id: "court-a", match_id: "M1" },
      {
        day_id: "day2",
        section_no: 2,
        court_id: "court-b",
        match_id: "M2",
        referee_assignment: { kind: "team", team_id: "A" },
      },
    ])).toEqual([]);
  });
});
