import { describe, expect, it, vi } from "vitest";

import { API_PATH, generateSchedule, ScheduleApiError } from "./api";

describe("日程生成API", () => {
  it("同一originへno-storeで送信する", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "OPTIMAL", slots: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await generateSchedule({ schema_version: "0.1.0" }, "turnstile-token", fetchMock);
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
    expect(new Headers(options?.headers).has("x-api-key")).toBe(false);
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
});
