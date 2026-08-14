import {
  leagueAwayFirstMatchIds,
  type LeagueDisplayMatch,
  type LeagueDisplaySlot,
} from "./league-team-display-order";
import { sameRankEntryKey } from "./same-rank-league";

export interface SameRankDisplayMatch {
  matchId: string;
  home: unknown;
  away: unknown;
}

export interface SameRankDisplaySlot {
  sectionNo: number;
  courtId: string;
  matchId: string;
  refereeRankRef?: unknown;
}

export function sameRankAwayFirstMatchIds(
  matches: readonly SameRankDisplayMatch[],
  slots: readonly SameRankDisplaySlot[],
): ReadonlySet<string> {
  const normalizedMatches: LeagueDisplayMatch[] = matches.map((match) => ({
    matchId: match.matchId,
    homeEntryKey: sameRankEntryKey(match.home),
    awayEntryKey: sameRankEntryKey(match.away),
  }));
  const normalizedSlots: LeagueDisplaySlot[] = slots.map((slot) => ({
    sectionNo: slot.sectionNo,
    courtId: slot.courtId,
    matchId: slot.matchId,
    refereeEntryKey: sameRankEntryKey(slot.refereeRankRef),
  }));
  return leagueAwayFirstMatchIds(normalizedMatches, normalizedSlots);
}
