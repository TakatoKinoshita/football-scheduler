import { describe, expect, it, vi } from "vitest";

import {
  API_PATH,
  createDay2,
  createSchedule,
  generateDay2Schedule,
  generateSchedule,
  generateTournamentPlan,
  ScheduleApiError,
} from "./api";

describe("日程生成API", () => {
  it("同一originへno-storeで送信する", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "OPTIMAL", slots: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const input = {
      schema_version: "0.2.0",
      final_stage: { format: "placement_tournament", tournament_count: 2 },
    };
    const result = await generateSchedule(input, "turnstile-token", fetchMock);
    expect(result.status).toBe("OPTIMAL");
    expect(fetchMock).toHaveBeenCalledWith(
      API_PATH,
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({ "x-turnstile-token": "turnstile-token" }),
      }),
    );
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(options?.body))).toEqual(input);
    expect(new Headers(options?.headers).has("x-api-key")).toBe(false);
    expect(new Headers(options?.headers).get("x-turnstile-action")).toBe("generate_schedule");
  });

  it("安全確認なしでは通信しない", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(generateSchedule({}, "", fetchMock)).rejects.toEqual(
      new ScheduleApiError("BOT_CHECK_REQUIRED", "安全確認を完了してから日程を生成してください。"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("API診断の日本語メッセージを表示用エラーにする", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "error",
          diagnostics: [{ code: "SCHEDULE_SEARCH_TIMEOUT", message: "時間内に日程を生成できませんでした。" }],
        }),
        { status: 422 },
      ),
    );
    await expect(generateSchedule({}, "token", fetchMock)).rejects.toMatchObject({
      code: "SCHEDULE_SEARCH_TIMEOUT",
      message: "時間内に日程を生成できませんでした。",
    });
  });

  it("API診断の項目別詳細を表示用エラーに保持する", async () => {
    const details = {
      errors: [{ field: "league.block_count", type: "missing" }],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "error",
          diagnostics: [
            {
              code: "INPUT_SCHEMA_INVALID",
              message: "大会設定を修正してください。",
              details,
            },
          ],
        }),
        { status: 400 },
      ),
    );

    await expect(generateSchedule({}, "token", fetchMock)).rejects.toMatchObject({
      code: "INPUT_SCHEMA_INVALID",
      details,
    });
  });

  it("トーナメント要求も同じ保護されたAPIへ送る", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "COMPLETE", upper: {}, lower: {} }), {
        status: 200,
      }),
    );
    const input = { request_kind: "tournament_plan" };

    await expect(generateTournamentPlan(input, "token", fetchMock)).resolves.toMatchObject({
      status: "COMPLETE",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-turnstile-action")).toBe(
      "generate_tournament",
    );
  });

  it("2日目日程要求も同じ保護されたAPIへ送る", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "OPTIMAL", schedule_scope: "day2_tournament" }), {
        status: 200,
      }),
    );
    const input = { request_kind: "day2_schedule" };

    await expect(generateDay2Schedule(input, "token", fetchMock)).resolves.toMatchObject({
      schedule_scope: "day2_tournament",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-turnstile-action")).toBe(
      "generate_day2_schedule",
    );
  });

  it("2日目一括作成をcreate_day2 actionで1回送る", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OPTIMAL",
          tournament_plan: { status: "COMPLETE" },
          day2_schedule: { status: "OPTIMAL" },
        }),
        { status: 200 },
      ),
    );
    const input = { request_kind: "day2_creation" };

    await expect(createDay2(input, "single-use-token", fetchMock)).resolves.toMatchObject({
      status: "OPTIMAL",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-turnstile-token")).toBe("single-use-token");
    expect(headers.get("x-turnstile-action")).toBe("create_day2");
  });

  it("両日一括作成をcreate_schedule actionで1回送る", async () => {
    const response = {
      schema_version: "0.2.0",
      status: "OPTIMAL",
      generation_scope: "all",
      tournament_result: { status: "OPTIMAL", slots: [] },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const input = { request_kind: "schedule_creation", generation_scope: "all" };

    await expect(createSchedule(input, "single-use-token", fetchMock)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-turnstile-token")).toBe("single-use-token");
    expect(headers.get("x-turnstile-action")).toBe("create_schedule");
  });

});
