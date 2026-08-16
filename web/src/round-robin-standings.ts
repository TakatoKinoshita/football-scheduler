export interface StandingMetrics {
  points: number;
  goal_difference: number;
  goals_for: number;
}

export interface RoundRobinStanding {
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  tieBreak: string;
  headToHead: StandingMetrics | null;
}

export interface RoundRobinDrawRecord {
  candidates: string[];
  decidedOrder: string[];
  randomSeed: number;
  candidateValues: Array<{ teamId: string; headToHead: StandingMetrics }>;
}

export interface RoundRobinMatchResult {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}

export interface RoundRobinRanking {
  standings: RoundRobinStanding[];
  draws: RoundRobinDrawRecord[];
}

export class LocalStandingsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LocalStandingsError";
  }
}

interface MutableStats {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

const emptyStats = (): MutableStats => ({
  played: 0,
  wins: 0,
  draws: 0,
  losses: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  points: 0,
});

function record(
  home: MutableStats,
  away: MutableStats,
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
    home.points += 3;
    away.losses += 1;
  } else if (homeScore < awayScore) {
    away.wins += 1;
    away.points += 3;
    home.losses += 1;
  } else {
    home.draws += 1;
    away.draws += 1;
    home.points += 1;
    away.points += 1;
  }
}

function key(stats: MutableStats): readonly [number, number, number] {
  return [stats.points, stats.goalsFor - stats.goalsAgainst, stats.goalsFor];
}

function keyText(value: readonly [number, number, number]): string {
  return value.join(":");
}

function compareKeysDescending(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metrics(stats: MutableStats): StandingMetrics {
  return {
    points: stats.points,
    goal_difference: stats.goalsFor - stats.goalsAgainst,
    goals_for: stats.goalsFor,
  };
}

async function sha256(value: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new LocalStandingsError(
      "LOCAL_STANDINGS_CRYPTO_UNAVAILABLE",
      "このブラウザでは再現可能な抽選を実行できません。ブラウザを更新して、もう一度お試しください。",
    );
  }
  try {
    return new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(value)));
  } catch {
    throw new LocalStandingsError(
      "LOCAL_STANDINGS_CRYPTO_UNAVAILABLE",
      "再現可能な抽選を実行できませんでした。ブラウザを更新して、もう一度お試しください。",
    );
  }
}

function compareDigest(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function drawOrder(
  scopeId: string,
  teams: readonly string[],
  randomSeed: number,
): Promise<string[]> {
  const candidates = [...teams].sort(compareIdentifiers);
  const candidateKey = candidates.join(",");
  const values = await Promise.all(candidates.map(async (teamId) => ({
    teamId,
    digest: await sha256(`${String(randomSeed)}:${scopeId}:${candidateKey}:${teamId}`),
  })));
  return values.sort((left, right) =>
    compareDigest(left.digest, right.digest) || compareIdentifiers(left.teamId, right.teamId)
  ).map((value) => value.teamId);
}

function groupedByKey(
  teams: readonly string[],
  stats: ReadonlyMap<string, MutableStats>,
): Array<{ key: readonly [number, number, number]; teams: string[] }> {
  const groups = new Map<string, {
    key: readonly [number, number, number];
    teams: string[];
  }>();
  for (const team of teams) {
    const value = key(stats.get(team)!);
    const text = keyText(value);
    const existing = groups.get(text);
    if (existing === undefined) groups.set(text, { key: value, teams: [team] });
    else existing.teams.push(team);
  }
  return [...groups.values()].sort((left, right) => compareKeysDescending(left.key, right.key));
}

export async function rankRoundRobinGroup(input: {
  scopeId: string;
  teamIds: readonly string[];
  matches: readonly RoundRobinMatchResult[];
  randomSeed: number;
}): Promise<RoundRobinRanking> {
  const stats = new Map(input.teamIds.map((teamId) => [teamId, emptyStats()]));
  for (const match of input.matches) {
    const home = stats.get(match.homeTeamId);
    const away = stats.get(match.awayTeamId);
    if (home === undefined || away === undefined || home === away) {
      throw new LocalStandingsError(
        "LOCAL_STANDINGS_MATCH_INVALID",
        "順位計算の対象に含まれないチームの試合があります。",
      );
    }
    record(home, away, match.homeScore, match.awayScore);
  }

  const ordered: string[] = [];
  const reasons = new Map<string, string>();
  const headToHead = new Map<string, StandingMetrics>();
  const draws: RoundRobinDrawRecord[] = [];
  for (const baseGroup of groupedByKey(input.teamIds, stats)) {
    if (baseGroup.teams.length === 1) {
      reasons.set(baseGroup.teams[0]!, "勝点・得失点差・総得点");
      ordered.push(baseGroup.teams[0]!);
      continue;
    }
    const mini = new Map(baseGroup.teams.map((teamId) => [teamId, emptyStats()]));
    for (const match of input.matches) {
      const home = mini.get(match.homeTeamId);
      const away = mini.get(match.awayTeamId);
      if (home !== undefined && away !== undefined) {
        record(home, away, match.homeScore, match.awayScore);
      }
    }
    for (const teamId of baseGroup.teams) headToHead.set(teamId, metrics(mini.get(teamId)!));
    for (const miniGroup of groupedByKey(baseGroup.teams, mini)) {
      if (miniGroup.teams.length === 1) {
        reasons.set(miniGroup.teams[0]!, "直接対戦");
        ordered.push(miniGroup.teams[0]!);
        continue;
      }
      const candidates = [...miniGroup.teams].sort(compareIdentifiers);
      const decidedOrder = await drawOrder(input.scopeId, candidates, input.randomSeed);
      draws.push({
        candidates,
        decidedOrder,
        randomSeed: input.randomSeed,
        candidateValues: candidates.map((teamId) => ({
          teamId,
          headToHead: headToHead.get(teamId)!,
        })),
      });
      for (const teamId of decidedOrder) reasons.set(teamId, "直接対戦後の抽選");
      ordered.push(...decidedOrder);
    }
  }

  return {
    standings: ordered.map((teamId) => {
      const value = stats.get(teamId)!;
      return {
        teamId,
        played: value.played,
        wins: value.wins,
        draws: value.draws,
        losses: value.losses,
        goalsFor: value.goalsFor,
        goalsAgainst: value.goalsAgainst,
        goalDifference: value.goalsFor - value.goalsAgainst,
        points: value.points,
        tieBreak: reasons.get(teamId) ?? "自動確定",
        headToHead: headToHead.get(teamId) ?? null,
      };
    }),
    draws,
  };
}
