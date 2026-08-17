import type { JsonObject, TournamentDocument } from "./types";

export const LEAGUE_RESULTS_WORKBOOK_FIXTURE_VERSION = "1.1.0";

export interface LeagueResultsWorkbookFixture {
  id: string;
  description: string;
  document: TournamentDocument;
}

interface FixtureMatch {
  id: string;
  blockId: string;
  homeTeamId: string;
  awayTeamId: string;
}

interface FixtureAggregate {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

interface TieGroupSpec {
  teamIds: string[];
  draw?: { candidates: string[]; decidedOrder: string[] };
}

interface BlockSpec {
  id: string;
  displayName?: string;
  teamIds: string[];
  scores?: Array<[number, number]>;
  ranking?: string[];
  tieGroups?: TieGroupSpec[];
}

interface FixtureSpec {
  id: string;
  description: string;
  tournamentName: string;
  teams: Array<{ id: string; name: string }>;
  blocks: BlockSpec[];
  randomSeed?: number;
  courtCount?: number;
}

function emptyAggregate(): FixtureAggregate {
  return {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
  };
}

function record(
  home: FixtureAggregate,
  away: FixtureAggregate,
  homeScore: number,
  awayScore: number,
): void {
  home.played += 1;
  away.played += 1;
  home.goalsFor += homeScore;
  home.goalsAgainst += awayScore;
  away.goalsFor += awayScore;
  away.goalsAgainst += homeScore;
  if (homeScore > awayScore) {
    home.wins += 1;
    away.losses += 1;
    home.points += 3;
  } else if (homeScore < awayScore) {
    away.wins += 1;
    home.losses += 1;
    away.points += 3;
  } else {
    home.draws += 1;
    away.draws += 1;
    home.points += 1;
    away.points += 1;
  }
}

function rounds(teamIds: readonly string[]): Array<Array<[string, string]>> {
  let rotating: Array<string | null> = [...teamIds];
  if (rotating.length % 2 === 1) rotating.push(null);
  const output: Array<Array<[string, string]>> = [];
  for (let roundIndex = 0; roundIndex < rotating.length - 1; roundIndex += 1) {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < rotating.length / 2; index += 1) {
      const left = rotating[index];
      const right = rotating[rotating.length - index - 1];
      if (left !== null && right !== null) {
        pairs.push(roundIndex % 2 === 0 ? [left!, right!] : [right!, left!]);
      }
    }
    output.push(pairs);
    rotating = [rotating[0]!, rotating.at(-1)!, ...rotating.slice(1, -1)];
  }
  return output;
}

function orderedScores(matches: readonly FixtureMatch[], teamIds: readonly string[]): Array<[number, number]> {
  const order = new Map(teamIds.map((teamId, index) => [teamId, index]));
  return matches.map((match) =>
    order.get(match.homeTeamId)! < order.get(match.awayTeamId)! ? [1, 0] : [0, 1]
  );
}

function fixture(spec: FixtureSpec): LeagueResultsWorkbookFixture {
  const randomSeed = spec.randomSeed ?? 20260803;
  const planBlocks: JsonObject[] = [];
  const logicalRounds: JsonObject[] = [];
  const matches: FixtureMatch[] = [];
  const rawMatches: JsonObject[] = [];
  const blockMatches = new Map<string, FixtureMatch[]>();
  for (const block of spec.blocks) {
    planBlocks.push({
      id: block.id,
      ...(block.displayName === undefined ? {} : { display_name: block.displayName }),
      team_ids: block.teamIds,
    });
    let matchNumber = 1;
    const currentMatches: FixtureMatch[] = [];
    for (const [roundIndex, pairings] of rounds(block.teamIds).entries()) {
      const roundMatchIds: string[] = [];
      for (const [homeTeamId, awayTeamId] of pairings) {
        const id = `LG-${block.id}-M${String(matchNumber)}`;
        const match = { id, blockId: block.id, homeTeamId, awayTeamId };
        matches.push(match);
        currentMatches.push(match);
        roundMatchIds.push(id);
        rawMatches.push({
          id,
          phase: "league",
          round: `${block.displayName ?? `${block.id}ブロック`} 第${String(roundIndex + 1)}ラウンド`,
          possible_home_team_ids: [homeTeamId],
          possible_away_team_ids: [awayTeamId],
          prerequisite_match_ids: [],
          organizer_referee_required: false,
        });
        matchNumber += 1;
      }
      logicalRounds.push({
        block_id: block.id,
        round_no: roundIndex + 1,
        match_ids: roundMatchIds,
      });
    }
    blockMatches.set(block.id, currentMatches);
  }

  const resultByMatch = new Map<string, { homeScore: number; awayScore: number }>();
  for (const block of spec.blocks) {
    const currentMatches = blockMatches.get(block.id)!;
    const scores = block.scores ?? orderedScores(currentMatches, block.teamIds);
    if (scores.length !== currentMatches.length) throw new Error(`${block.id}のfixture得点数が不正です。`);
    currentMatches.forEach((match, index) => {
      const score = scores[index]!;
      resultByMatch.set(match.id, { homeScore: score[0], awayScore: score[1] });
    });
  }

  const aggregate = new Map(spec.teams.map((team) => [team.id, emptyAggregate()]));
  for (const match of matches) {
    const score = resultByMatch.get(match.id)!;
    record(
      aggregate.get(match.homeTeamId)!,
      aggregate.get(match.awayTeamId)!,
      score.homeScore,
      score.awayScore,
    );
  }

  const standings: JsonObject[] = [];
  const drawRecords: JsonObject[] = [];
  for (const block of spec.blocks) {
    const ranking = block.ranking ?? block.teamIds;
    const tieGroupByTeam = new Map<string, TieGroupSpec>();
    const headToHead = new Map<string, FixtureAggregate>();
    for (const group of block.tieGroups ?? []) {
      const mini = new Map(group.teamIds.map((teamId) => [teamId, emptyAggregate()]));
      for (const match of blockMatches.get(block.id)!) {
        const home = mini.get(match.homeTeamId);
        const away = mini.get(match.awayTeamId);
        if (home === undefined || away === undefined) continue;
        const score = resultByMatch.get(match.id)!;
        record(home, away, score.homeScore, score.awayScore);
      }
      for (const teamId of group.teamIds) {
        tieGroupByTeam.set(teamId, group);
        headToHead.set(teamId, mini.get(teamId)!);
      }
      if (group.draw !== undefined) {
        drawRecords.push({
          block_id: block.id,
          candidates: group.draw.candidates,
          decided_order: group.draw.decidedOrder,
          random_seed: randomSeed,
          candidate_values: group.draw.candidates.map((teamId) => {
            const value = headToHead.get(teamId)!;
            return {
              team_id: teamId,
              head_to_head: {
                points: value.points,
                goal_difference: value.goalsFor - value.goalsAgainst,
                goals_for: value.goalsFor,
              },
            };
          }),
        });
      }
    }
    standings.push(...ranking.map((teamId, index): JsonObject => {
      const value = aggregate.get(teamId)!;
      const group = tieGroupByTeam.get(teamId);
      const mini = headToHead.get(teamId);
      const drawn = group?.draw?.candidates.includes(teamId) ?? false;
      return {
        block_id: block.id,
        rank: index + 1,
        team_id: teamId,
        played: value.played,
        wins: value.wins,
        draws: value.draws,
        losses: value.losses,
        goals_for: value.goalsFor,
        goals_against: value.goalsAgainst,
        goal_difference: value.goalsFor - value.goalsAgainst,
        points: value.points,
        tie_break: group === undefined
          ? "勝点・得失点差・総得点"
          : drawn ? "直接対戦後の抽選" : "直接対戦",
        head_to_head: mini === undefined ? null : {
          points: mini.points,
          goal_difference: mini.goalsFor - mini.goalsAgainst,
          goals_for: mini.goalsFor,
        },
      };
    }));
  }

  return {
    id: spec.id,
    description: spec.description,
    document: {
      documentType: "football-scheduler-tournament",
      schemaVersion: "0.2.0",
      updatedAt: "2026-08-17T06:00:00.000Z",
      tournament: {
        name: spec.tournamentName,
        input: {
          schema_version: "0.2.0",
          request_kind: "day1_league",
          teams: spec.teams,
          courts: Array.from({ length: spec.courtCount ?? 1 }, (_, index) => ({
            id: `court-${String(index + 1)}`,
            name: `${String(index + 1)}コート`,
          })),
          league: { block_count: spec.blocks.length, assignment_mode: "seeded_snake" },
          random_seed: randomSeed,
        },
        result: {
          league_plan: {
            schema_version: "0.2.0",
            assignment_mode: "seeded_snake",
            random_seed: randomSeed,
            blocks: planBlocks,
            logical_rounds: logicalRounds,
            matches: rawMatches,
          },
          league_results: matches.map((match) => {
            const score = resultByMatch.get(match.id)!;
            return {
              match_id: match.id,
              home_score: score.homeScore,
              away_score: score.awayScore,
            };
          }),
          league_standings: {
            schema_version: "0.2.0",
            status: "COMPLETE",
            standings,
            draws: drawRecords,
          },
        },
      },
    },
  };
}

function teams(prefix: string, count: number): Array<{ id: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index + 1)}`,
    name: `${prefix}チーム${String(index + 1)}`,
  }));
}

function orderedFixture(size: 2 | 8 | 16): LeagueResultsWorkbookFixture {
  const members = teams("T", size);
  return fixture({
    id: `league-results-normal-${String(size)}`,
    description: `${String(size)}チーム・通常順位のリーグ結果`,
    tournamentName: `${String(size)}チーム リーグ結果確認大会`,
    teams: members,
    blocks: [{ id: "A", teamIds: members.map((team) => team.id) }],
  });
}

const fourTeams = ["A", "B", "C", "D"].map((id) => ({ id, name: `チーム${id}` }));

const sixteenTeamFourBlockMembers = Array.from({ length: 16 }, (_, index) => ({
  id: `team-${String(index + 1).padStart(2, "0")}`,
  name: `チーム${String(index + 1).padStart(2, "0")}`,
}));

export const leagueResultsWorkbookFixtures: readonly LeagueResultsWorkbookFixture[] = [
  orderedFixture(2),
  fixture({
    id: "league-results-direct-4",
    description: "4チーム・2組の直接対戦を含むリーグ結果",
    tournamentName: "直接対戦確認大会",
    teams: fourTeams,
    blocks: [{
      id: "A",
      teamIds: ["A", "B", "C", "D"],
      scores: [[0, 1], [1, 0], [1, 0], [0, 1], [1, 0], [1, 0]],
      ranking: ["C", "D", "A", "B"],
      tieGroups: [{ teamIds: ["C", "D"] }, { teamIds: ["A", "B"] }],
    }],
  }),
  fixture({
    id: "league-results-mini-league-4",
    description: "4チーム・3チームミニリーグを含むリーグ結果",
    tournamentName: "ミニリーグ確認大会",
    teams: fourTeams,
    blocks: [{
      id: "A",
      teamIds: ["A", "B", "C", "D"],
      scores: [[5, 0], [2, 0], [3, 0], [4, 2], [1, 0], [3, 1]],
      ranking: ["C", "B", "A", "D"],
      tieGroups: [{ teamIds: ["A", "B", "C"] }],
    }],
  }),
  fixture({
    id: "league-results-residual-draw-5",
    description: "5チーム・残存同点群を再計算しない抽選を含むリーグ結果",
    tournamentName: "残存同点抽選確認大会",
    teams: ["A", "B", "C", "D", "E"].map((id) => ({ id, name: `チーム${id}` })),
    blocks: [{
      id: "A",
      teamIds: ["A", "B", "C", "D", "E"],
      scores: [[4, 0], [1, 2], [2, 3], [3, 1], [4, 2], [4, 1], [0, 0], [1, 4], [2, 3], [1, 3]],
      ranking: ["A", "B", "D", "E", "C"],
      tieGroups: [{
        teamIds: ["B", "D", "E"],
        draw: { candidates: ["B", "D"], decidedOrder: ["B", "D"] },
      }],
    }],
  }),
  fixture({
    id: "league-results-all-draws-4",
    description: "4チーム・全試合引き分けの抽選を含むリーグ結果",
    tournamentName: "全引き分け抽選確認大会",
    teams: fourTeams,
    randomSeed: 99,
    blocks: [{
      id: "A",
      teamIds: ["A", "B", "C", "D"],
      scores: Array.from({ length: 6 }, (): [number, number] => [0, 0]),
      ranking: ["A", "C", "B", "D"],
      tieGroups: [{
        teamIds: ["A", "B", "C", "D"],
        draw: { candidates: ["A", "B", "C", "D"], decidedOrder: ["A", "C", "B", "D"] },
      }],
    }],
  }),
  fixture({
    id: "league-results-multiple-blocks-long-names",
    description: "複数ブロック・長い日本語名・重複sheet名のリーグ結果",
    tournamentName: `地域交流大会${"長い日本語大会名".repeat(8)}`,
    teams: [
      ...teams("A", 4).map((team, index) => ({
        ...team,
        name: index === 0 ? `=先頭記号${"長い日本語チーム名".repeat(8)}` : team.name,
      })),
      ...teams("B", 4),
    ],
    blocks: [
      { id: "east", displayName: "東地区/予選", teamIds: ["A1", "A2", "A3", "A4"] },
      { id: "west", displayName: "東地区:予選", teamIds: ["B1", "B2", "B3", "B4"] },
    ],
  }),
  fixture({
    id: "league-results-16-teams-4-blocks-3-courts",
    description: "16チーム・4ブロック・3コートのリーグ結果",
    tournamentName: "16チーム 4ブロック リーグ結果確認大会",
    teams: sixteenTeamFourBlockMembers,
    courtCount: 3,
    blocks: ["A", "B", "C", "D"].map((id, blockIndex) => ({
      id,
      displayName: `${id}ブロック`,
      teamIds: sixteenTeamFourBlockMembers
        .slice(blockIndex * 4, blockIndex * 4 + 4)
        .map((team) => team.id),
    })),
  }),
  orderedFixture(8),
  orderedFixture(16),
];

export function leagueResultsWorkbookFixture(
  id: string,
): LeagueResultsWorkbookFixture | undefined {
  return leagueResultsWorkbookFixtures.find((candidate) => candidate.id === id);
}
