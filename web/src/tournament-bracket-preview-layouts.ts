import {
  standardTournamentBracketLayout,
  type TournamentBracketLayoutStrategy,
} from "./tournament-bracket";

export const tournamentBracketPreviewLayouts = {
  standard: standardTournamentBracketLayout,
} as const satisfies Readonly<Record<string, TournamentBracketLayoutStrategy>>;

export type TournamentBracketPreviewLayoutName = keyof typeof tournamentBracketPreviewLayouts;

export function tournamentBracketPreviewLayout(
  name: string,
): TournamentBracketLayoutStrategy | undefined {
  return Object.prototype.hasOwnProperty.call(tournamentBracketPreviewLayouts, name)
    ? tournamentBracketPreviewLayouts[name as TournamentBracketPreviewLayoutName]
    : undefined;
}
