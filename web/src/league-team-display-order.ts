export type CanonicalTeamSide = "home" | "away";

export interface LeagueDisplayMatch {
  matchId: string;
  homeEntryKey?: string | undefined;
  awayEntryKey?: string | undefined;
}

export interface LeagueDisplaySlot {
  sectionNo: number;
  courtId: string;
  matchId: string;
  refereeEntryKey?: string | undefined;
}

export interface DisplayedTeamPair<T> {
  left: T;
  right: T;
  leftSide: CanonicalTeamSide;
  rightSide: CanonicalTeamSide;
}

export function displayedTeamPair<T>(
  home: T,
  away: T,
  awayFirst = false,
): DisplayedTeamPair<T> {
  return awayFirst
    ? { left: away, right: home, leftSide: "away", rightSide: "home" }
    : { left: home, right: away, leftSide: "home", rightSide: "away" };
}

function slotKey(sectionNo: number, courtId: string): string {
  return `${String(sectionNo)}\u0000${courtId}`;
}

/**
 * 現在の試合のaway側が、直後の同一コートの試合を審判する試合IDを返す。
 * entry keyには1日目のチームIDまたは2日目同順位リーグの順位枠IDを利用できる。
 */
export function leagueAwayFirstMatchIds(
  matches: readonly LeagueDisplayMatch[],
  slots: readonly LeagueDisplaySlot[],
): ReadonlySet<string> {
  const matchById = new Map(matches.map((match) => [match.matchId, match] as const));
  const slotByPosition = new Map(
    slots.map((slot) => [slotKey(slot.sectionNo, slot.courtId), slot] as const),
  );
  const awayFirst = new Set<string>();

  for (const current of slots) {
    const match = matchById.get(current.matchId);
    if (
      match?.homeEntryKey === undefined ||
      match.awayEntryKey === undefined ||
      match.homeEntryKey === match.awayEntryKey
    ) {
      continue;
    }
    const next = slotByPosition.get(slotKey(current.sectionNo + 1, current.courtId));
    if (next?.refereeEntryKey === match.awayEntryKey) awayFirst.add(current.matchId);
  }

  return awayFirst;
}
