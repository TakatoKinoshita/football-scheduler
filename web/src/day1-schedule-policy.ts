import type { JsonObject } from "./types";

export type Day1AssignmentRole = "match" | "referee";

export interface Day1AdjacentCourtViolation {
  teamId: string;
  sectionNos: readonly [number, number];
  courtIds: readonly [string, string];
  roles: readonly [Day1AssignmentRole, Day1AssignmentRole];
  matchIds: readonly [string, string];
}

interface Assignment {
  courtId: string;
  role: Day1AssignmentRole;
  matchId: string;
}

export function day1AdjacentCourtViolations(
  matches: readonly JsonObject[],
  slots: readonly JsonObject[],
): Day1AdjacentCourtViolation[] {
  const matchesById = new Map(
    matches
      .filter((match): match is JsonObject & { id: string } => typeof match.id === "string")
      .map((match) => [match.id, match] as const),
  );
  const assignments = new Map<string, Assignment[]>();
  const addAssignment = (
    teamId: string,
    sectionNo: number,
    assignment: Assignment,
  ): void => {
    const key = assignmentKey(teamId, sectionNo);
    const existing = assignments.get(key) ?? [];
    if (
      !existing.some(
        (item) =>
          item.courtId === assignment.courtId &&
          item.role === assignment.role &&
          item.matchId === assignment.matchId,
      )
    ) {
      existing.push(assignment);
      assignments.set(key, existing);
    }
  };

  for (const slot of slots) {
    if (
      slot.day_id !== "day1" ||
      !Number.isInteger(slot.section_no) ||
      Number(slot.section_no) < 1 ||
      typeof slot.court_id !== "string" ||
      typeof slot.match_id !== "string"
    ) {
      continue;
    }
    const match = matchesById.get(slot.match_id);
    if (match === undefined) continue;
    const sectionNo = Number(slot.section_no);
    for (const teamId of matchTeamIds(match)) {
      addAssignment(teamId, sectionNo, {
        courtId: slot.court_id,
        role: "match",
        matchId: slot.match_id,
      });
    }
    const referee = objectValue(slot.referee_assignment ?? slot.referee);
    const kind = referee?.kind ?? referee?.type;
    if (kind === "team" && typeof referee?.team_id === "string") {
      addAssignment(referee.team_id, sectionNo, {
        courtId: slot.court_id,
        role: "referee",
        matchId: slot.match_id,
      });
    }
  }

  const violations: Day1AdjacentCourtViolation[] = [];
  for (const [key, earlier] of [...assignments].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const parsed = parseAssignmentKey(key);
    if (parsed === undefined) continue;
    const later = assignments.get(assignmentKey(parsed.teamId, parsed.sectionNo + 1)) ?? [];
    for (const left of sortedAssignments(earlier)) {
      for (const right of sortedAssignments(later)) {
        if (
          left.courtId === right.courtId ||
          left.role !== "match" ||
          right.role !== "referee"
        ) continue;
        violations.push({
          teamId: parsed.teamId,
          sectionNos: [parsed.sectionNo, parsed.sectionNo + 1],
          courtIds: [left.courtId, right.courtId],
          roles: [left.role, right.role],
          matchIds: [left.matchId, right.matchId],
        });
      }
    }
  }
  return violations;
}

function matchTeamIds(match: JsonObject): Set<string> {
  const teamIds = new Set<string>();
  for (const field of [
    "possible_team_ids",
    "candidate_team_ids",
    "possible_home_team_ids",
    "possible_away_team_ids",
  ]) {
    const values = match[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) teamIds.add(value);
    }
  }
  for (const field of ["home_team_id", "away_team_id"]) {
    const value = match[field];
    if (typeof value === "string" && value.length > 0) teamIds.add(value);
  }
  for (const field of ["home", "away"]) {
    const reference = objectValue(match[field]);
    const teamId = reference?.team_id;
    if (
      (reference?.type === "concrete_team" || reference?.type === "team") &&
      typeof teamId === "string" &&
      teamId.length > 0
    ) {
      teamIds.add(teamId);
    }
  }
  return teamIds;
}

function assignmentKey(teamId: string, sectionNo: number): string {
  return `${teamId}\u0000${String(sectionNo)}`;
}

function parseAssignmentKey(value: string): { teamId: string; sectionNo: number } | undefined {
  const separator = value.lastIndexOf("\u0000");
  if (separator < 0) return undefined;
  const sectionNo = Number(value.slice(separator + 1));
  if (!Number.isInteger(sectionNo)) return undefined;
  return { teamId: value.slice(0, separator), sectionNo };
}

function sortedAssignments(values: readonly Assignment[]): Assignment[] {
  return [...values].sort(
    (left, right) =>
      left.courtId.localeCompare(right.courtId) ||
      left.role.localeCompare(right.role) ||
      left.matchId.localeCompare(right.matchId),
  );
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
