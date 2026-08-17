import upperEightJson from "./fixtures/tournament-bracket-preview/upper-8.json";
import upperSixteenJson from "./fixtures/tournament-bracket-preview/upper-16.json";
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
  category?: string;
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

export interface PrintPreviewRoute {
  participant: PrintParticipant;
  resolvedTeamId?: string;
  role: "match" | "referee";
  match_id: string;
  section_no: number;
  court_id: string;
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
  sectionTimings?: readonly {
    section_no: number;
    start_time: string | null;
    match_end: string | null;
  }[];
  groups: readonly PrintPreviewGroup[];
  matches: readonly PrintPreviewMatch[];
  slots: readonly PrintPreviewSlot[];
  routes?: readonly PrintPreviewRoute[];
  tournamentPlan?: JsonObject;
  tournamentResults?: readonly JsonObject[];
  finalStandings?: JsonObject;
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
  "北斗ジュニアサッカーアカデミー",
  "オーシャンズフットボールクラブ",
  "緑ヶ丘スポーツ少年団",
  "サンライズジュニアユナイテッド",
  "中央台フットボールクラブU-12",
  "ひかり野サッカースポーツ少年団",
  "ゴールデンイーグルスジュニア",
  "山手フットボールアカデミー",
  "ベイサイドキッカーズ",
  "花園ジュニアサッカークラブ",
  "フォレストユナイテッドU-12",
  "高原サッカースポーツ少年団",
  "リバーサイドフットボールクラブ",
  "旭町ジュニアFC",
  "ブルースカイサッカーアカデミー",
  "希望ヶ丘フットボールクラブ",
] as const;

const ALL_TEAMS = TEAM_NAMES.map((name, index) => ({
  id: `team-${String(index + 1).padStart(2, "0")}`,
  name,
}));

const ALL_BLOCK_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

const DAY_SETTINGS = {
  start_time: "09:30",
  game_duration_minutes: 35,
  margin_minutes: 5,
  breaks: [{ after_section: 5, duration_minutes: 45 }],
} as const;

function teamsFor(teamCount: 16 | 32): readonly { id: string; name: string }[] {
  return ALL_TEAMS.slice(0, teamCount);
}

function courtsFor(courtCount: 3 | 4): readonly { id: string; name: string }[] {
  return Array.from({ length: courtCount }, (_, index) => {
    const name = String.fromCharCode("A".charCodeAt(0) + index);
    return { id: `court-${name.toLowerCase()}`, name: `${name}コート` };
  });
}

function blockIdsFor(blockCount: 4 | 8): readonly string[] {
  return ALL_BLOCK_IDS.slice(0, blockCount);
}

function concrete(teamId: string): PrintParticipant {
  return { type: "concrete_team", team_id: teamId };
}

function leagueRank(blockId: string, rank: number): PrintParticipant {
  return { type: "league_rank", block_id: blockId, rank };
}

function scheduledSlots(
  matches: readonly PrintPreviewMatch[],
  courts: readonly { id: string; name: string }[],
): PrintPreviewSlot[] {
  const slots = matches.map((match, index): PrintPreviewSlot => ({
    section_no: Math.floor(index / courts.length) + 1,
    court_id: courts[index % courts.length]!.id,
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
  const participantCount = groups[0]?.members.length ?? 0;
  if (
    participantCount < 2
    || participantCount % 2 !== 0
    || groups.some((group) => group.members.length !== participantCount)
  ) {
    throw new Error("印刷fixtureの総当たりグループ人数が不正です。");
  }
  const rotation = Array.from({ length: participantCount }, (_, index) => index);
  const roundPairs: Array<Array<readonly [number, number]>> = [];
  for (let round = 0; round < participantCount - 1; round += 1) {
    roundPairs.push(Array.from({ length: participantCount / 2 }, (_, pairIndex) => [
      rotation[pairIndex]!,
      rotation[participantCount - pairIndex - 1]!,
    ] as const));
    rotation.splice(1, 0, rotation.pop()!);
  }
  for (const [roundIndex, pairs] of roundPairs.entries()) {
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

function day1Fixture(
  teamCount: 16 | 32,
  courtCount: 3 | 4,
  blockCount: 4 | 8,
): PrintPreviewFixture {
  const teams = teamsFor(teamCount);
  const courts = courtsFor(courtCount);
  const blockIds = blockIdsFor(blockCount);
  const groups = blockIds.map((blockId, index): PrintPreviewGroup => ({
    id: blockId,
    name: `${blockId}ブロック`,
    members: teams.slice(index * 4, index * 4 + 4).map((team) => concrete(team.id)),
  }));
  const matches = roundRobinMatches("LG", groups);
  return {
    id: `day1-league-${String(teamCount)}`,
    description: `${String(teamCount)}チーム・${String(blockCount)}ブロック・${String(courtCount)}コートの1日目リーグ`,
    scope: "day1-league",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams,
    courts,
    daySettings: DAY_SETTINGS,
    groups,
    matches,
    slots: scheduledSlots(matches, courts),
    participantResolution: "resolved",
  };
}

function sameRankFixture(
  teamCount: 16 | 32,
  courtCount: 3 | 4,
  blockCount: 4 | 8,
  resolved: boolean,
): PrintPreviewFixture {
  const teams = teamsFor(teamCount);
  const courts = courtsFor(courtCount);
  const blockIds = blockIdsFor(blockCount);
  const groups = [1, 2, 3, 4].map((rank): PrintPreviewGroup => ({
    id: `rank-${String(rank)}`,
    name: `${String(rank)}位グループ`,
    members: blockIds.map((blockId, blockIndex) => resolved
      ? concrete(teams[blockIndex * 4 + rank - 1]!.id)
      : leagueRank(blockId, rank)),
  }));
  const matches = roundRobinMatches("SR", groups);
  return {
    id: resolved
      ? `day2-same-rank-${String(teamCount)}-resolved`
      : `day2-same-rank-${String(teamCount)}-provisional`,
    description: resolved
      ? `${String(teamCount)}チーム・${String(blockCount)}ブロック・${String(courtCount)}コートの順位確定後同順位リーグ`
      : `${String(teamCount)}チーム・${String(blockCount)}ブロック・${String(courtCount)}コートの仮同順位リーグ`,
    scope: "day2-same-rank",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams,
    courts,
    daySettings: { ...DAY_SETTINGS, margin_minutes: 10 },
    groups,
    matches,
    slots: scheduledSlots(matches, courts),
    participantResolution: resolved ? "resolved" : "provisional",
  };
}

type SourcePreview = { tournament_plan: { upper: JsonObject; status: unknown; random_seed: unknown } };

function sourceEntryOrder(
  sourceUpper: JsonObject,
  blockIds: readonly string[],
): ReadonlyMap<string, readonly [string, number]> {
  const sourceBlocks = (sourceUpper.seeds as JsonObject[]).map((seed) => String(seed.block_id));
  const targetEntries = blockIds.flatMap((blockId) => [
    [blockId, 1] as const,
    [blockId, 2] as const,
  ]);
  return new Map(sourceBlocks.map((sourceBlock, index) => [sourceBlock, targetEntries[index]!]));
}

function mapTournamentValue(
  value: unknown,
  poolIndex: number,
  entryOrder: ReadonlyMap<string, readonly [string, number]>,
  blockIds: readonly string[],
  teams: readonly { id: string; name: string }[],
  participantCount: 8 | 16,
): unknown {
  if (typeof value === "string") {
    if (value.startsWith("UT-")) return `PT-${String(poolIndex)}-${value.slice(3)}`;
    if (value === "upper") return `placement-${String(poolIndex)}`;
    if (value === "upper_tournament") return "placement_tournament";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) =>
      mapTournamentValue(child, poolIndex, entryOrder, blockIds, teams, participantCount)
    );
  }
  if (value === null || typeof value !== "object") return value;
  const source = value as JsonObject;
  const mapped = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [
      key,
      mapTournamentValue(child, poolIndex, entryOrder, blockIds, teams, participantCount),
    ]),
  ) as JsonObject;
  const sourceEntry = typeof source.block_id === "string"
    ? entryOrder.get(source.block_id)
    : undefined;
  if (sourceEntry !== undefined) {
    const [blockId, localRank] = sourceEntry;
    const rank = localRank + (poolIndex - 1) * 2;
    mapped.block_id = blockId;
    if (typeof source.rank === "number") mapped.rank = rank;
    if (typeof source.block_rank === "number") mapped.block_rank = rank;
    const teamIndex = blockIds.indexOf(blockId) * 4 + rank - 1;
    if (typeof source.team_id === "string") mapped.team_id = teams[teamIndex]!.id;
  }
  if (
    Array.isArray(source.rank_range)
    && source.rank_range.length === 2
    && source.rank_range.every((rank) => typeof rank === "number")
  ) {
    mapped.rank_range = source.rank_range.map(
      (rank) => Number(rank) + (poolIndex - 1) * participantCount,
    );
  }
  return mapped;
}

function placementPool(
  sourceUpper: JsonObject,
  poolIndex: number,
  blockIds: readonly string[],
  teams: readonly { id: string; name: string }[],
  participantCount: 8 | 16,
): JsonObject {
  const mapped = mapTournamentValue(
    structuredClone(sourceUpper),
    poolIndex,
    sourceEntryOrder(sourceUpper, blockIds),
    blockIds,
    teams,
    participantCount,
  ) as JsonObject;
  const matches = (mapped.matches as JsonObject[]).map((match) => ({
    ...match,
    phase: "placement_tournament",
    pool_id: `placement-${String(poolIndex)}`,
  }));
  const placements = (mapped.placements as JsonObject[]).map((placement) => ({
    ...placement,
    rank: Number(placement.rank) + (poolIndex - 1) * participantCount,
    pool_rank: Number(placement.rank),
  }));
  delete mapped.pool;
  delete mapped.byes;
  return {
    ...mapped,
    pool_id: `placement-${String(poolIndex)}`,
    pool_index: poolIndex,
    display_name: `第${String(poolIndex)}順位決定トーナメント`,
    pool_rank_range: [1, participantCount],
    overall_rank_range: [
      (poolIndex - 1) * participantCount + 1,
      poolIndex * participantCount,
    ],
    matches,
    placements,
  };
}

function tournamentFixture(
  teamCount: 16 | 32,
  courtCount: 3 | 4,
  blockCount: 4 | 8,
  resolved: boolean,
): PrintPreviewFixture {
  const teams = teamsFor(teamCount);
  const courts = courtsFor(courtCount);
  const blockIds = blockIdsFor(blockCount);
  const participantCount = (teamCount / 2) as 8 | 16;
  const source = (participantCount === 8 ? upperEightJson : upperSixteenJson) as unknown as SourcePreview;
  const plan: JsonObject = {
    schema_version: "0.2.0",
    format: "placement_tournament",
    tournament_count: 2,
    status: source.tournament_plan.status,
    participant_resolution: resolved ? "resolved" : "provisional",
    random_seed: source.tournament_plan.random_seed,
    pools: [
      placementPool(source.tournament_plan.upper, 1, blockIds, teams, participantCount),
      placementPool(source.tournament_plan.upper, 2, blockIds, teams, participantCount),
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
  const roundCounts = new Map<number, number>();
  for (const match of matches) {
    const round = Number(matchData.get(match.id)?.round_no ?? 0);
    roundCounts.set(round, (roundCounts.get(round) ?? 0) + 1);
  }
  const firstSectionByRound = new Map<number, number>();
  let nextSection = 1;
  for (const [round, count] of [...roundCounts].sort(([left], [right]) => left - right)) {
    firstSectionByRound.set(round, nextSection);
    nextSection += Math.ceil(count / courts.length) + 1;
  }
  const finalRound = Math.max(...roundCounts.keys());
  const baseSlots = matches.map((match): PrintPreviewSlot => {
    const round = Number(matchData.get(match.id)?.round_no ?? 0);
    const index = indexByRound.get(round) ?? 0;
    indexByRound.set(round, index + 1);
    const firstSection = firstSectionByRound.get(round)!;
    return {
      section_no: firstSection + Math.floor(index / courts.length),
      court_id: courts[index % courts.length]!.id,
      match_id: match.id,
      referee_assignment: { kind: "organizer" },
    };
  });
  const slots = baseSlots.map((slot): PrintPreviewSlot => {
    const match = slot.match_id === null ? undefined : matchData.get(slot.match_id);
    if (slot.section_no === 1 || Number(match?.round_no) === finalRound) {
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
    id: resolved
      ? `day2-tournament-${String(teamCount)}-resolved`
      : `day2-tournament-${String(teamCount)}-provisional`,
    description: resolved
      ? `${String(teamCount)}チーム・2トーナメント・${String(courtCount)}コートの順位確定後トーナメント`
      : `${String(teamCount)}チーム・2トーナメント・${String(courtCount)}コートの仮トーナメント`,
    scope: "day2-tournament",
    tournamentName: "第18回 地域交流ジュニアサッカー大会",
    savedAt: "2026-08-17T06:00:00.000Z",
    teams,
    courts,
    daySettings: { ...DAY_SETTINGS, margin_minutes: 10 },
    groups: [],
    matches,
    slots,
    tournamentPlan: plan,
    participantResolution: resolved ? "resolved" : "provisional",
  };
}

export const printPreviewFixtures: readonly PrintPreviewFixture[] = [
  day1Fixture(16, 3, 4),
  sameRankFixture(16, 3, 4, false),
  sameRankFixture(16, 3, 4, true),
  tournamentFixture(16, 3, 4, false),
  tournamentFixture(16, 3, 4, true),
  day1Fixture(32, 4, 8),
  sameRankFixture(32, 4, 8, false),
  sameRankFixture(32, 4, 8, true),
  tournamentFixture(32, 4, 8, false),
  tournamentFixture(32, 4, 8, true),
];

export function printPreviewFixture(id: string): PrintPreviewFixture | undefined {
  return printPreviewFixtures.find((fixture) => fixture.id === id);
}
