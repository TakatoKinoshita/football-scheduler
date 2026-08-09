import { describe, expect, it, vi } from "vitest";

import {
  type Environment,
  type FetchImplementation,
  proxyScheduleRequest,
} from "./[[path]]";

const environment: Environment = {
  AWS_API_ORIGIN: "https://api-id.execute-api.us-east-1.amazonaws.com/prod",
  ORIGIN_VERIFY_VALUE: "01234567890123456789012345678901",
  API_USAGE_KEY: "01234567890123456789",
};

function request(body = "{}", headers: Record<string, string> = {}): Request {
  return new Request("https://schedule.pages.dev/api/v1/schedules:generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://schedule.pages.dev",
      "x-turnstile-token": "single-use-token",
      "x-turnstile-action": "generate_schedule",
      ...headers,
    },
    body,
  });
}

describe("Cloudflare Pages API proxy", () => {
  it("秘密値と利用者IPをAWS APIへだけ付与する", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response('{"status":"OPTIMAL"}', {
        status: 200,
        headers: { "content-type": "application/json", "x-release-id": "release-1" },
      }),
    );

    const response = await proxyScheduleRequest(
      request("{}", { "cf-connecting-ip": "203.0.113.10" }),
      environment,
      fetchMock,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-release-id")).toBe("release-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, options] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe(
      "https://api-id.execute-api.us-east-1.amazonaws.com/prod/api/v1/schedules:generate",
    );
    expect(options?.redirect).toBe("manual");
    const forwarded = new Headers(options?.headers);
    expect(forwarded.get("origin")).toBe("https://schedule.pages.dev");
    expect(forwarded.get("x-origin-verify")).toBe(environment.ORIGIN_VERIFY_VALUE);
    expect(forwarded.get("x-api-key")).toBe(environment.API_USAGE_KEY);
    expect(forwarded.get("x-client-ip")).toBe("203.0.113.10");
    expect(forwarded.get("x-turnstile-action")).toBe("generate_schedule");
  });

  it("1 MBを超える入力はAWSへ送信しない", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const response = await proxyScheduleRequest(request("a".repeat(1_000_001)), environment, fetchMock);

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: [{ code: "INPUT_TOO_LARGE" }],
    });
  });

  it("設定不備では秘密値を応答へ含めない", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const response = await proxyScheduleRequest(
      request(),
      { ...environment, ORIGIN_VERIFY_VALUE: "short" },
      fetchMock,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("short");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AWS APIからのredirectを追跡せず利用者へ転送しない", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response("redirect response body", {
        status: 307,
        headers: { location: "https://unexpected.example/secret-path" },
      }),
    );

    const response = await proxyScheduleRequest(request(), environment, fetchMock);

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    const body = await response.text();
    expect(body).toContain("UPSTREAM_REDIRECT_REJECTED");
    expect(body).not.toContain("unexpected.example");
    expect(body).not.toContain("redirect response body");
  });

  it("API以外のpathを転送しない", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const other = new Request("https://schedule.pages.dev/api/v1/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const response = await proxyScheduleRequest(other, environment, fetchMock);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未登録のTurnstile actionはAWSへ送信しない", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const response = await proxyScheduleRequest(
      request("{}", { "x-turnstile-action": "other_action" }),
      environment,
      fetchMock,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: [{ code: "BOT_CHECK_ACTION_REQUIRED" }],
    });
  });

  it("最終順位確定のTurnstile actionをAWSへ転送する", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response('{"status":"COMPLETE"}', { status: 200 }),
    );

    const response = await proxyScheduleRequest(
      request('{"request_kind":"tournament_results"}', {
        "x-turnstile-action": "calculate_tournament_results",
      }),
      environment,
      fetchMock,
    );

    expect(response.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(options?.headers).get("x-turnstile-action")).toBe(
      "calculate_tournament_results",
    );
  });

  it("2日目一括作成のTurnstile actionをAWSへ転送する", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response('{"status":"OPTIMAL"}', { status: 200 }),
    );

    const response = await proxyScheduleRequest(
      request('{"request_kind":"day2_creation"}', {
        "x-turnstile-action": "create_day2",
      }),
      environment,
      fetchMock,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(options?.headers).get("x-turnstile-action")).toBe("create_day2");
  });
});
