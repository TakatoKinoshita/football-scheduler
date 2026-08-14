import {
  displayedTeamPair,
  leagueAwayFirstMatchIds,
  type CanonicalTeamSide,
  type DisplayedTeamPair,
} from "./league-team-display-order";

export { displayedTeamPair };
export type { CanonicalTeamSide, DisplayedTeamPair };

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

/**
 * 現在の試合のawayチームが、直後の同一コートの試合を審判する試合IDを返す。
 * 試合・スロットの正本は変更せず、タブ3の表示順だけを決める。
 */
export function day1AwayFirstMatchIds(
  matches: readonly Day1DisplayMatch[],
  slots: readonly Day1DisplaySlot[],
): ReadonlySet<string> {
  return leagueAwayFirstMatchIds(
    matches.map((match) => ({
      matchId: match.matchId,
      homeEntryKey: match.homeTeamId,
      awayEntryKey: match.awayTeamId,
    })),
    slots.map((slot) => ({
      sectionNo: slot.sectionNo,
      courtId: slot.courtId,
      matchId: slot.matchId,
      refereeEntryKey: slot.refereeTeamId,
    })),
  );
}
