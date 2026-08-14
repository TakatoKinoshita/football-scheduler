export type SameRankRole = "match" | "referee";

export interface SameRankRoleEntry {
  section: number;
  court: string;
  role: SameRankRole;
  matchId: string;
}

export type SameRankRoleSequenceViolation =
  | "consecutive_match"
  | "consecutive_referee"
  | "match_to_referee_court_change"
  | "referee_source_invalid";

export function sameRankRoleSequenceViolation(
  entries: readonly SameRankRoleEntry[],
): SameRankRoleSequenceViolation | undefined {
  const ordered = [...entries].sort(
    (left, right) =>
      left.section - right.section ||
      left.court.localeCompare(right.court) ||
      left.role.localeCompare(right.role) ||
      left.matchId.localeCompare(right.matchId),
  );

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const previous = ordered[index - 1];
    if (current.role === "referee") {
      if (
        previous !== undefined &&
        current.section === previous.section + 1 &&
        previous.role === "referee"
      ) {
        return "consecutive_referee";
      }
      if (
        previous === undefined ||
        current.section !== previous.section + 1 ||
        previous.role !== "match"
      ) {
        return "referee_source_invalid";
      }
      if (current.court !== previous.court) {
        return "match_to_referee_court_change";
      }
      continue;
    }
    if (previous === undefined || current.section !== previous.section + 1) continue;
    if (previous.role === "match") return "consecutive_match";

    const refereeSource = ordered[index - 2];
    if (
      refereeSource === undefined ||
      refereeSource.role !== "match" ||
      refereeSource.section !== previous.section - 1 ||
      refereeSource.court !== previous.court
    ) {
      return "referee_source_invalid";
    }
  }
  return undefined;
}
