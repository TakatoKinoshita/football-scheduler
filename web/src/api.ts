import type { JsonObject } from "./types";

export const API_PATH = "/api/v1/schedules:generate";
const MAX_BYTES = 1_000_000;
const TIMEOUT_MILLISECONDS = 30_000;

export class ScheduleApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: JsonObject,
  ) {
    super(message);
    this.name = "ScheduleApiError";
  }
}

export async function generateSchedule(
  input: JsonObject,
  turnstileToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<JsonObject> {
  const body = JSON.stringify(input);
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES) {
    throw new ScheduleApiError("INPUT_TOO_LARGE", "入力が1 MBを超えています。不要な内容を減らしてください。");
  }
  if (turnstileToken.length === 0) {
    throw new ScheduleApiError("BOT_CHECK_REQUIRED", "安全確認を完了してから日程を生成してください。");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MILLISECONDS);
  try {
    const response = await fetchImplementation(API_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": turnstileToken,
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > MAX_BYTES) {
      throw new ScheduleApiError("RESPONSE_TOO_LARGE", "生成結果が大きすぎるため表示できませんでした。");
    }
    let result: unknown;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new ScheduleApiError("INVALID_RESPONSE", "サーバーからの応答を読み取れませんでした。もう一度お試しください。");
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new ScheduleApiError("INVALID_RESPONSE", "サーバーからの応答を読み取れませんでした。もう一度お試しください。");
    }
    const object = result as JsonObject;
    if (!response.ok || object.status === "error") {
      const diagnostics = Array.isArray(object.diagnostics) ? object.diagnostics : [];
      const first = diagnostics[0];
      if (typeof first === "object" && first !== null) {
        const diagnostic = first as JsonObject;
        throw new ScheduleApiError(
          typeof diagnostic.code === "string" ? diagnostic.code : "GENERATION_FAILED",
          typeof diagnostic.message === "string"
            ? diagnostic.message
            : "日程を生成できませんでした。入力内容を確認してください。",
          typeof diagnostic.details === "object" &&
            diagnostic.details !== null &&
            !Array.isArray(diagnostic.details)
            ? (diagnostic.details as JsonObject)
            : undefined,
        );
      }
      throw new ScheduleApiError("GENERATION_FAILED", "日程を生成できませんでした。時間をおいて再度お試しください。");
    }
    return object;
  } catch (error) {
    if (error instanceof ScheduleApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ScheduleApiError(
        "GENERATION_TIMEOUT",
        "30秒以内に生成が終わりませんでした。入力は保存されています。時間をおいて再度お試しください。",
      );
    }
    throw new ScheduleApiError(
      "NETWORK_UNAVAILABLE",
      "通信できないため日程を生成できません。保存済みの日程は引き続き確認できます。",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** 日程生成と同じ保護されたAPIで、保存済みのリーグ結果から順位を確定する。 */
export function calculateLeagueStandings(
  input: JsonObject,
  turnstileToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<JsonObject> {
  return generateSchedule(input, turnstileToken, fetchImplementation);
}

/** 確定したリーグ順位から、上位・下位の完全順位決定表を生成する。 */
export function generateTournamentPlan(
  input: JsonObject,
  turnstileToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<JsonObject> {
  return generateSchedule(input, turnstileToken, fetchImplementation);
}
