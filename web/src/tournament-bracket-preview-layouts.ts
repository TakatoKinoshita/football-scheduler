import type {
  TournamentBracketLayoutStrategy,
  TournamentBracketModel,
} from "./tournament-bracket";
import {
  tournamentBracketPresentation,
  tournamentBracketPresentations,
} from "./tournament-bracket-presentations";

export const tournamentBracketPreviewLayouts = {
  standard: tournamentBracketPresentations.standard.layout,
  vertical: tournamentBracketPresentations.vertical.layout,
  horizontal: tournamentBracketPresentations.horizontal.layout,
} as const satisfies Readonly<Record<string, TournamentBracketLayoutStrategy>>;

export type TournamentBracketPreviewLayoutName = keyof typeof tournamentBracketPreviewLayouts;

export function tournamentBracketPreviewLayout(
  name: string,
): TournamentBracketLayoutStrategy | undefined {
  return Object.prototype.hasOwnProperty.call(tournamentBracketPreviewLayouts, name)
    ? tournamentBracketPreviewLayouts[name as TournamentBracketPreviewLayoutName]
    : undefined;
}

export function tournamentBracketPreviewRenderer(
  name: string,
): ((model: TournamentBracketModel, heading: string) => HTMLElement) | undefined {
  return tournamentBracketPresentation(name)?.render;
}
