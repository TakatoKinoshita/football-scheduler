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
});
