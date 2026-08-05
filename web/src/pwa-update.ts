export interface PwaRegistrationCallbacks {
  onNeedRefresh: () => void;
  onOfflineReady: () => void;
}

export type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>;

type RegisterPwa = (callbacks: PwaRegistrationCallbacks) => UpdateServiceWorker;

interface PwaUpdateOptions {
  confirmRefresh: () => boolean;
  onOfflineReady: () => void;
}

export function setupPwaUpdates(
  registerPwa: RegisterPwa,
  options: PwaUpdateOptions,
): UpdateServiceWorker {
  let updateServiceWorker: UpdateServiceWorker | undefined;
  let refreshPromptHandled = false;
  updateServiceWorker = registerPwa({
    onNeedRefresh() {
      if (refreshPromptHandled || updateServiceWorker === undefined) return;
      refreshPromptHandled = true;
      if (!options.confirmRefresh()) return;
      void updateServiceWorker(true);
    },
    onOfflineReady: options.onOfflineReady,
  });
  return updateServiceWorker;
}
