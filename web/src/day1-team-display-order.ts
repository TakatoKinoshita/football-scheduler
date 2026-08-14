export type CanonicalTeamSide = "home" | "away";

export interface Day1DisplayMatch {
  matchId: string;
  homeTeamId?: string | undefined;
  awayTeamId?: string | undefined;
}

export interface Day1DisplaySlot {
  sectionNo: number;
  courtId: string;
  matchId: string;
  refereeTeamId?: string | undefined;
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
 * 現在の試合のawayチームが、直後の同一コートの試合を審判する試合IDを返す。
 * 試合・スロットの正本は変更せず、タブ3の表示順だけを決める。
 */
export function day1AwayFirstMatchIds(
  matches: readonly Day1DisplayMatch[],
  slots: readonly Day1DisplaySlot[],
): ReadonlySet<string> {
  const matchById = new Map(matches.map((match) => [match.matchId, match] as const));
  const slotByPosition = new Map(
    slots.map((slot) => [slotKey(slot.sectionNo, slot.courtId), slot] as const),
  );
  const awayFirst = new Set<string>();

  for (const current of slots) {
    const match = matchById.get(current.matchId);
    if (
      match?.homeTeamId === undefined ||
      match.awayTeamId === undefined ||
      match.homeTeamId === match.awayTeamId
    ) {
      continue;
    }
    const next = slotByPosition.get(slotKey(current.sectionNo + 1, current.courtId));
    if (next?.refereeTeamId === match.awayTeamId) awayFirst.add(current.matchId);
  }

  return awayFirst;
}
