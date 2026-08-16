import upperEightJson from "./fixtures/tournament-bracket-preview/upper-8.json";
import type { JsonObject } from "./types";

export const PRINT_PREVIEW_FIXTURE_MARKER = "PRINT_PREVIEW_FIXTURE_V1";

export type PrintPreviewScope = "day1-league" | "day2-same-rank" | "day2-tournament";

export type PrintParticipant =
  | { type: "concrete_team"; team_id: string }
  | { type: "league_rank"; block_id: string; rank: number }
  | { type: "winner_of"; match_id: string }
  | { type: "loser_of"; match_id: string };

export type PrintReferee =
  | { kind: "organizer" }
  | { kind: "team"; team: PrintParticipant }
  | { kind: "previous_match_winner"; match_id: string };

export interface PrintPreviewMatch {
  id: string;
  home: PrintParticipant;
  away: PrintParticipant;
}

export interface PrintPreviewSlot {
  section_no: number;
  court_id: string;
  match_id: string | null;
  referee_assignment: PrintReferee;
}

export interface PrintPreviewGroup {
  id: string;
  name: string;
  members: readonly PrintParticipant[];
}

export interface PrintPreviewFixture {
  id: string;
  description: string;
  scope: PrintPreviewScope;
  tournamentName: string;
  savedAt: string;
  teams: readonly { id: string; name: string }[];
  courts: readonly { id: string; name: string }[];
  daySettings: {
    start_time: string;
    game_duration_minutes: number;
    margin_minutes: number;
    breaks: readonly { after_section: number; duration_minutes: number }[];
  };
  groups: readonly PrintPreviewGroup[];
  matches: readonly PrintPreviewMatch[];
  slots: readonly PrintPreviewSlot[];
  tournamentPlan?: JsonObject;
  participantResolution: "provisional" | "resolved";
}

const TEAM_NAMES = [
  "北町ジュニアフットボールクラブ",
  "南ヶ丘サッカースポーツ少年団",
  "青空ユナイテッドU-12",
  "桜台フットボールアカデミー",
  "西海岸ジュニアサッカークラブ",
  "みどり野スポーツ少年団",
  "東中央フットボールクラブ",
  "白鷺サッカーアカデミー",
  "港南ブルーウェーブ",
  "若葉ジュニアユナイテッド",
  "大樹フットボールクラブ",
  "朝日ヶ丘サッカー少年団",
  "レインボーキッカーズ",
  "川辺ジュニアFC",
  "つばさユナイテッド",
  "星空フットボールクラブ",
] as const;

const TEAMS = TEAM_NAMES.map((name, index) => ({
  id: `team-${String(index + 1).padStart(2, "0")}`,
  name,
}));

const COURTS = ["A", "B", "C"].map((name) => ({
  id: `court-${name.toLowerCase()}`,
  name: `${name}コート`,
}));

const DAY_SETTINGS = {
  start_time: "09:30",
  game_duration_minutes: 35,
  margin_minutes: 5,
  breaks: [{ after_section: 5, duration_minutes: 45 }],
} as const;

const BLOCK_IDS = ["A", "B", "C", "D"] as const;
const ROUND_ROBIN = [
  [[0, 3], [1, 2]],
  [[0, 2], [3, 1]],
  [[0, 1], [2, 3]],
] as const;

function concrete(teamId: string): PrintParticipant {
  return { type: "concrete_team", team_id: teamId };
}

function leagueRank(blockId: string, rank: number): PrintParticipant {
  return { type: "league_rank", block_id: blockId, rank };
}

function scheduledSlots(matches: readonly PrintPreviewMatch[]): PrintPreviewSlot[] {
  const slots = matches.map((match, index): PrintPreviewSlot => ({
    section_no: Math.floor(index / COURTS.length) + 1,
    court_id: COURTS[index % COURTS.length]!.id,
    match_id: match.id,
    referee_assignment: { kind: "organizer" },
  }));
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const slotByPosition = new Map(slots.map((slot) => [
    `${String(slot.section_no)}:${slot.court_id}`,
    slot,
  ]));
  return slots.map((slot) => {
    if (slot.section_no === 1) return slot;
    const previous = slotByPosition.get(`${String(slot.section_no - 1)}:${slot.court_id}`);
    const previousMatch = previous?.match_id === null || previous?.match_id === undefined
      ? undefined
      : matchById.get(previous.match_id);
    return previousMatch === undefined
      ? slot
      : { ...slot, referee_assignment: { kind: "team", team: previousMatch.home } };
  });
}

function roundRobinMatches(
  prefix: string,
  groups: readonly PrintPreviewGroup[],
): PrintPreviewMatch[] {
  const matches: PrintPreviewMatch[] = [];
  for (const [roundIndex, pairs] of ROUND_ROBIN.entries()) {
    for (const group of groups) {
      for (const [pairIndex, pair] of pairs.entries()) {
        matches.push({
          id: `${prefix}-${group.id}-R${String(roundIndex + 1)}-M${String(pairIndex + 1)}`,
          home: group.members[pair[0]]!,
          away: group.members[pair[1]]!,
        });
      }
    }
  }
  return matches;
}

function day1Fixture(): PrintPreviewFixture {
  const groups = BLOCK_IDS.map((blockId, index): PrintPreviewGroup => ({
    id: blockId,
    name: `${blockId}ブロック`,
    members: TEAMS.slice(index * 4, index * 4 + 4).map((team) => concrete(team.id)),
  }));
  const matches = roundRobinMatches("LG", groups);
  return {
    id: "day1-league-16",
    description: "16チーム・4ブロック・3コートの1日目リーグ",
    scope: "day1-league",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams: TEAMS,
    courts: COURTS,
    daySettings: DAY_SETTINGS,
    groups,
    matches,
    slots: scheduledSlots(matches),
    participantResolution: "resolved",
  };
}

function sameRankFixture(resolved: boolean): PrintPreviewFixture {
  const groups = [1, 2, 3, 4].map((rank): PrintPreviewGroup => ({
    id: `rank-${String(rank)}`,
    name: `${String(rank)}位グループ`,
    members: BLOCK_IDS.map((blockId, blockIndex) => resolved
      ? concrete(TEAMS[blockIndex * 4 + rank - 1]!.id)
      : leagueRank(blockId, rank)),
  }));
  const matches = roundRobinMatches("SR", groups);
  return {
    id: resolved ? "day2-same-rank-16-resolved" : "day2-same-rank-16-provisional",
    description: resolved
      ? "16チーム・4ブロック・3コートの順位確定後同順位リーグ"
      : "16チーム・4ブロック・3コートの仮同順位リーグ",
    scope: "day2-same-rank",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams: TEAMS,
    courts: COURTS,
    daySettings: { ...DAY_SETTINGS, margin_minutes: 10 },
    groups,
    matches,
    slots: scheduledSlots(matches),
    participantResolution: resolved ? "resolved" : "provisional",
  };
}

type SourcePreview = { tournament_plan: { upper: JsonObject; status: unknown; random_seed: unknown } };

const SOURCE_ENTRY_ORDER: Readonly<Record<string, readonly [string, number]>> = {
  D: ["A", 1],
  B: ["B", 1],
  A: ["C", 1],
  F: ["D", 1],
  G: ["A", 2],
  C: ["B", 2],
  H: ["C", 2],
  E: ["D", 2],
};

function mapTournamentValue(value: unknown, poolIndex: number): unknown {
  if (typeof value === "string") {
    if (value.startsWith("UT-")) return `PT-${String(poolIndex)}-${value.slice(3)}`;
    if (value === "upper") return `placement-${String(poolIndex)}`;
    if (value === "upper_tournament") return "placement_tournament";
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => mapTournamentValue(child, poolIndex));
  if (value === null || typeof value !== "object") return value;
  const source = value as JsonObject;
  const mapped = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, mapTournamentValue(child, poolIndex)]),
  ) as JsonObject;
  if (typeof source.block_id === "string" && SOURCE_ENTRY_ORDER[source.block_id] !== undefined) {
    const [blockId, localRank] = SOURCE_ENTRY_ORDER[source.block_id]!;
    const rank = localRank + (poolIndex - 1) * 2;
    mapped.block_id = blockId;
    if (typeof source.rank === "number") mapped.rank = rank;
    if (typeof source.block_rank === "number") mapped.block_rank = rank;
    const teamIndex = BLOCK_IDS.indexOf(blockId as typeof BLOCK_IDS[number]) * 4 + rank - 1;
    if (typeof source.team_id === "string") mapped.team_id = TEAMS[teamIndex]!.id;
  }
  if (
    Array.isArray(source.rank_range)
    && source.rank_range.length === 2
    && source.rank_range.every((rank) => typeof rank === "number")
  ) {
    mapped.rank_range = source.rank_range.map((rank) => Number(rank) + (poolIndex - 1) * 8);
  }
  return mapped;
}

function placementPool(sourceUpper: JsonObject, poolIndex: number): JsonObject {
  const mapped = mapTournamentValue(structuredClone(sourceUpper), poolIndex) as JsonObject;
  const matches = (mapped.matches as JsonObject[]).map((match) => ({
    ...match,
    phase: "placement_tournament",
    pool_id: `placement-${String(poolIndex)}`,
  }));
  const placements = (mapped.placements as JsonObject[]).map((placement) => ({
    ...placement,
    rank: Number(placement.rank) + (poolIndex - 1) * 8,
    pool_rank: Number(placement.rank),
  }));
  delete mapped.pool;
  delete mapped.byes;
  return {
    ...mapped,
    pool_id: `placement-${String(poolIndex)}`,
    pool_index: poolIndex,
    display_name: `第${String(poolIndex)}順位決定トーナメント`,
    pool_rank_range: [1, 8],
    overall_rank_range: [(poolIndex - 1) * 8 + 1, poolIndex * 8],
    matches,
    placements,
  };
}

function tournamentFixture(resolved: boolean): PrintPreviewFixture {
  const source = upperEightJson as unknown as SourcePreview;
  const plan: JsonObject = {
    schema_version: "0.2.0",
    format: "placement_tournament",
    tournament_count: 2,
    status: source.tournament_plan.status,
    participant_resolution: resolved ? "resolved" : "provisional",
    random_seed: source.tournament_plan.random_seed,
    pools: [
      placementPool(source.tournament_plan.upper, 1),
      placementPool(source.tournament_plan.upper, 2),
    ],
    seed_draws: [],
    warnings: [],
  };
  const matches = (plan.pools as JsonObject[])
    .flatMap((pool) => pool.matches as JsonObject[])
    .map((match): PrintPreviewMatch => ({
      id: String(match.id),
      home: match.home as PrintParticipant,
      away: match.away as PrintParticipant,
    }))
    .sort((left, right) => {
      const sourceMatches = (plan.pools as JsonObject[]).flatMap((pool) => pool.matches as JsonObject[]);
      const round = (id: string) => Number(sourceMatches.find((match) => match.id === id)?.round_no ?? 0);
      return round(left.id) - round(right.id) || left.id.localeCompare(right.id);
    });
  const matchData = new Map(
    (plan.pools as JsonObject[]).flatMap((pool) => pool.matches as JsonObject[])
      .map((match) => [String(match.id), match] as const),
  );
  const indexByRound = new Map<number, number>();
  const baseSlots = matches.map((match): PrintPreviewSlot => {
    const round = Number(matchData.get(match.id)?.round_no ?? 0);
    const index = indexByRound.get(round) ?? 0;
    indexByRound.set(round, index + 1);
    const firstSection = round === 1 ? 1 : round === 2 ? 5 : 9;
    return {
      section_no: firstSection + Math.floor(index / COURTS.length),
      court_id: COURTS[index % COURTS.length]!.id,
      match_id: match.id,
      referee_assignment: { kind: "organizer" },
    };
  });
  const slots = baseSlots.map((slot): PrintPreviewSlot => {
    const match = slot.match_id === null ? undefined : matchData.get(slot.match_id);
    if (slot.section_no === 1 || Number(match?.round_no) === 3) {
      return { ...slot, referee_assignment: { kind: "organizer" } };
    }
    const previous = baseSlots.find((candidate) =>
      candidate.court_id === slot.court_id && candidate.section_no === slot.section_no - 1
    );
    return previous?.match_id === null || previous?.match_id === undefined
      ? { ...slot, referee_assignment: { kind: "organizer" } }
      : {
          ...slot,
          referee_assignment: { kind: "previous_match_winner", match_id: previous.match_id },
        };
  });
  return {
    id: resolved ? "day2-tournament-16-resolved" : "day2-tournament-16-provisional",
    description: resolved
      ? "16チーム・2トーナメント・3コートの順位確定後トーナメント"
      : "16チーム・2トーナメント・3コートの仮トーナメント",
    scope: "day2-tournament",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams: TEAMS,
    courts: COURTS,
    daySettings: { ...DAY_SETTINGS, margin_minutes: 10 },
    groups: [],
    matches,
    slots,
    tournamentPlan: plan,
    participantResolution: resolved ? "resolved" : "provisional",
  };
}

export const printPreviewFixtures: readonly PrintPreviewFixture[] = [
  day1Fixture(),
  sameRankFixture(false),
  sameRankFixture(true),
  tournamentFixture(false),
  tournamentFixture(true),
];

export function printPreviewFixture(id: string): PrintPreviewFixture | undefined {
  return printPreviewFixtures.find((fixture) => fixture.id === id);
}
