import {
  standardTournamentBracketLayout,
  type TournamentBracketLayoutStrategy,
  type TournamentBracketModel,
} from "./tournament-bracket";
import { renderTournamentBracket } from "./tournament-bracket";
import { renderTournamentBracketExploration } from "./tournament-bracket-exploration-renderer";
import {
  horizontalTournamentBracketLayout,
  verticalTournamentBracketLayout,
} from "./tournament-bracket-exploration-layouts";

export const tournamentBracketPreviewLayouts = {
  standard: standardTournamentBracketLayout,
  vertical: verticalTournamentBracketLayout,
  horizontal: horizontalTournamentBracketLayout,
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
  if (name === "standard") return renderTournamentBracket;
  if (name === "vertical" || name === "horizontal") return renderTournamentBracketExploration;
  return undefined;
}
