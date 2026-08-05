import { describe, expect, it, vi } from "vitest";

import {
  setupPwaUpdates,
  type PwaRegistrationCallbacks,
  type UpdateServiceWorker,
} from "./pwa-update";

function registrationFixture(): {
  callbacks: () => PwaRegistrationCallbacks;
  register: (callbacks: PwaRegistrationCallbacks) => UpdateServiceWorker;
  update: ReturnType<typeof vi.fn<UpdateServiceWorker>>;
} {
  let captured: PwaRegistrationCallbacks | undefined;
  const update = vi.fn<UpdateServiceWorker>().mockResolvedValue(undefined);
  const register = (callbacks: PwaRegistrationCallbacks): UpdateServiceWorker => {
    captured = callbacks;
    return update;
  };
  return {
    callbacks: () => {
      if (captured === undefined) throw new Error("PWA callbackが登録されていません。");
      return captured;
    },
    register,
    update,
  };
}

describe("setupPwaUpdates", () => {
  it("利用者が更新を承認したら待機中のservice workerを有効化する", () => {
    const fixture = registrationFixture();

    setupPwaUpdates(fixture.register, {
      confirmRefresh: () => true,
      onOfflineReady: vi.fn(),
    });
    fixture.callbacks().onNeedRefresh();

    expect(fixture.update).toHaveBeenCalledOnce();
    expect(fixture.update).toHaveBeenCalledWith(true);
  });

  it("利用者が更新を保留したら現在の画面を維持する", () => {
    const fixture = registrationFixture();

    setupPwaUpdates(fixture.register, {
      confirmRefresh: () => false,
      onOfflineReady: vi.fn(),
    });
    fixture.callbacks().onNeedRefresh();

    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("オフライン準備完了の通知を呼び出す", () => {
    const fixture = registrationFixture();
    const onOfflineReady = vi.fn();

    setupPwaUpdates(fixture.register, {
      confirmRefresh: () => true,
      onOfflineReady,
    });
    fixture.callbacks().onOfflineReady();

    expect(onOfflineReady).toHaveBeenCalledOnce();
  });
});
