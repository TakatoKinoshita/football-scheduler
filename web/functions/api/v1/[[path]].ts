const API_PATH = "/api/v1/schedules:generate";
const MAX_BODY_BYTES = 1_000_000;
const TURNSTILE_ACTIONS = new Set([
  "create_schedule",
  "generate_schedule",
  "calculate_standings",
  "generate_tournament",
  "calculate_tournament_results",
  "generate_same_rank_league",
  "calculate_same_rank_results",
  "generate_same_rank_day2_schedule",
  "create_day2",
  "generate_day2_schedule",
]);

export interface Environment {
  AWS_API_ORIGIN: string;
  ORIGIN_VERIFY_VALUE: string;
  API_USAGE_KEY: string;
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { status: "error", diagnostics: [{ code, message }] },
    {
      status,
      headers: {
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function upstreamUrl(origin: string): URL | null {
  try {
    const base = new URL(origin.endsWith("/") ? origin : `${origin}/`);
    if (base.protocol !== "https:") return null;
    return new URL("api/v1/schedules:generate", base);
  } catch {
    return null;
  }
}

export async function proxyScheduleRequest(
  request: Request,
  environment: Environment,
  fetchImplementation: FetchImplementation = fetch,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== API_PATH) {
    return errorResponse(404, "NOT_FOUND", "指定された操作は見つかりませんでした。");
  }
  if (request.method !== "POST") {
    return errorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "この操作ではPOSTリクエストだけを受け付けます。",
    );
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "大会設定はJSON形式で送信してください。",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return errorResponse(
        400,
        "INVALID_REQUEST",
        "リクエストのサイズ情報を読み取れませんでした。",
      );
    }
    if (length > MAX_BODY_BYTES) {
      return errorResponse(
        413,
        "INPUT_TOO_LARGE",
        "入力データが上限の1 MBを超えています。不要な内容を減らしてください。",
      );
    }
  }

  const turnstileToken = request.headers.get("x-turnstile-token") ?? "";
  if (turnstileToken.length === 0 || turnstileToken.length > 2_048) {
    return errorResponse(
      400,
      "BOT_CHECK_REQUIRED",
      "安全確認を完了してから日程を生成してください。",
    );
  }
  const turnstileAction = request.headers.get("x-turnstile-action") ?? "";
  if (!TURNSTILE_ACTIONS.has(turnstileAction)) {
    return errorResponse(
      400,
      "BOT_CHECK_ACTION_REQUIRED",
      "この操作の安全確認をやり直してください。",
    );
  }
  const browserOrigin = request.headers.get("origin") ?? "";
  if (!browserOrigin.startsWith("https://")) {
    return errorResponse(
      400,
      "BROWSER_ORIGIN_REQUIRED",
      "安全な接続から日程生成をやり直してください。",
    );
  }

  const target = upstreamUrl(environment.AWS_API_ORIGIN);
  if (
    target === null ||
    environment.ORIGIN_VERIFY_VALUE.length < 32 ||
    environment.API_USAGE_KEY.length < 20
  ) {
    return errorResponse(
      503,
      "SERVICE_CONFIGURATION_ERROR",
      "現在、日程生成サービスを利用できません。時間をおいて再度お試しください。",
    );
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return errorResponse(
      413,
      "INPUT_TOO_LARGE",
      "入力データが上限の1 MBを超えています。不要な内容を減らしてください。",
    );
  }

  const headers = new Headers({
    "content-type": "application/json",
    origin: browserOrigin,
    "x-api-key": environment.API_USAGE_KEY,
    "x-origin-verify": environment.ORIGIN_VERIFY_VALUE,
    "x-turnstile-token": turnstileToken,
    "x-turnstile-action": turnstileAction,
  });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-client-ip", clientIp);

  let upstream: Response;
  try {
    upstream = await fetchImplementation(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
  } catch {
    return errorResponse(
      502,
      "UPSTREAM_UNAVAILABLE",
      "日程生成サービスへ接続できませんでした。入力は保存されています。時間をおいて再度お試しください。",
    );
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return errorResponse(
      502,
      "UPSTREAM_REDIRECT_REJECTED",
      "日程生成サービスから予期しない応答がありました。入力は保存されています。時間をおいて再度お試しください。",
    );
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store, max-age=0",
    "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["retry-after", "x-release-id"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const onRequest: PagesFunction<Environment> = (context) =>
  proxyScheduleRequest(context.request, context.env);
