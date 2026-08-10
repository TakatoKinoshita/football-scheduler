import type { JsonObject } from "./types";

export interface TournamentResultDraft {
  regularHome: string;
  regularAway: string;
  penaltyHome: string;
  penaltyAway: string;
}

export type TournamentResultDrafts = Record<string, TournamentResultDraft>;

export interface TournamentResultDraftUiState {
  planFingerprint: string;
  drafts: TournamentResultDrafts;
}

export type TournamentResultDraftEvaluation =
  | { status: "inputting"; penaltyRequired: boolean }
  | { status: "invalid"; penaltyRequired: boolean; message: string }
  | {
      status: "ready";
      penaltyRequired: boolean;
      regularHome: number;
      regularAway: number;
      penaltyHome?: number;
      penaltyAway?: number;
    };

function score(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function evaluateTournamentResultDraft(
  draft: TournamentResultDraft,
): TournamentResultDraftEvaluation {
  const regularHome = score(draft.regularHome);
  const regularAway = score(draft.regularAway);
  if (regularHome === null || regularAway === null) {
    return { status: "inputting", penaltyRequired: false };
  }
  if (regularHome === undefined || regularAway === undefined) {
    return {
      status: "invalid",
      penaltyRequired: false,
      message: "通常得点は0以上の整数で入力してください。",
    };
  }
  if (regularHome !== regularAway) {
    return { status: "ready", penaltyRequired: false, regularHome, regularAway };
  }
  const penaltyHome = score(draft.penaltyHome);
  const penaltyAway = score(draft.penaltyAway);
  if (penaltyHome === null || penaltyAway === null) {
    return { status: "inputting", penaltyRequired: true };
  }
  if (penaltyHome === undefined || penaltyAway === undefined) {
    return {
      status: "invalid",
      penaltyRequired: true,
      message: "PK得点は0以上の整数で入力してください。",
    };
  }
  if (penaltyHome === penaltyAway) {
    return {
      status: "invalid",
      penaltyRequired: true,
      message: "PK戦は勝敗が決まるまで入力してください。",
    };
  }
  return {
    status: "ready",
    penaltyRequired: true,
    regularHome,
    regularAway,
    penaltyHome,
    penaltyAway,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 保存対象のplanが同じかを端末内で判定するための決定的なfingerprint。 */
export function tournamentPlanFingerprint(plan: JsonObject): string {
  const canonical = canonicalJson(plan);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `placement-plan-v1:${String(canonical.length)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneDraft(draft: TournamentResultDraft): TournamentResultDraft {
  return { ...draft };
}

export class TournamentResultDraftController {
  private fingerprint?: string;
  private readonly drafts = new Map<string, TournamentResultDraft>();

  activate(planFingerprint: string, restored: TournamentResultDrafts = {}): void {
    this.fingerprint = planFingerprint;
    this.drafts.clear();
    for (const [matchId, draft] of Object.entries(restored)) {
      this.drafts.set(matchId, cloneDraft(draft));
    }
  }

  reset(): void {
    this.fingerprint = undefined;
    this.drafts.clear();
  }

  get planFingerprint(): string | undefined {
    return this.fingerprint;
  }

  get(matchId: string): TournamentResultDraft | undefined {
    const draft = this.drafts.get(matchId);
    return draft === undefined ? undefined : cloneDraft(draft);
  }

  set(matchId: string, draft: TournamentResultDraft): void {
    if (this.fingerprint === undefined) {
      throw new Error("トーナメント計画を設定してから入力途中の結果を保存してください。");
    }
    this.drafts.set(matchId, cloneDraft(draft));
  }

  delete(matchId: string): void {
    this.drafts.delete(matchId);
  }

  deleteMany(matchIds: Iterable<string>): void {
    for (const matchId of matchIds) this.drafts.delete(matchId);
  }

  get hasPendingDrafts(): boolean {
    return this.drafts.size > 0;
  }

  snapshot(): TournamentResultDraftUiState | undefined {
    if (this.fingerprint === undefined || this.drafts.size === 0) return undefined;
    return {
      planFingerprint: this.fingerprint,
      drafts: Object.fromEntries(
        [...this.drafts].map(([matchId, draft]) => [matchId, cloneDraft(draft)]),
      ),
    };
  }
}
