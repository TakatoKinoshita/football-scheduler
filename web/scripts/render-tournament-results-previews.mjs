import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const WEB_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_IDS = [
  "production-current",
  "compact-table",
  "integrated-status-table",
  "responsive-cards",
  "responsive-cards-quiet-table",
];
const WIDTHS = [375, 768, 1002, 1280];
const SCENARIOS = ["mixed", "winner-change"];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedFrom(requested, supported, label) {
  if (requested === undefined || requested === "all") return supported;
  if (!supported.includes(requested)) throw new Error(`未対応の${label}です: ${requested}`);
  return [requested];
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("ローカルプレビュー用ポートを確保できませんでした。");
  }
  await new Promise((resolvePromise, reject) =>
    server.close((error) => error === undefined ? resolvePromise() : reject(error))
  );
  return address.port;
}

async function waitForServer(url, processOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Viteがlistenするまで短く待つ。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`Viteの起動を確認できませんでした。\n${processOutput()}`);
}

function stopServer(server) {
  if (server.exitCode !== null || server.pid === undefined) return;
  if (process.platform === "win32") server.kill("SIGTERM");
  else process.kill(-server.pid, "SIGTERM");
}

async function main() {
  const layouts = selectedFrom(option("--layout"), LAYOUT_IDS, "レイアウト");
  const scenarios = selectedFrom(option("--scenario") ?? "mixed", SCENARIOS, "状態サンプル");
  const requestedWidth = option("--width");
  const widths = requestedWidth === undefined || requestedWidth === "all"
    ? WIDTHS
    : selectedFrom(Number(requestedWidth), WIDTHS, "表示幅");
  const breakpoint = Number(option("--card-breakpoint") ?? "899");
  if (!Number.isInteger(breakpoint) || breakpoint < 320 || breakpoint > 1600) {
    throw new Error("カード切替幅は320〜1600の整数で指定してください。");
  }
  const requestedOutput = option("--output-dir");
  const outputDirectory = requestedOutput === undefined
    ? await mkdtemp(join(tmpdir(), "football-scheduler-result-input-previews-"))
    : resolve(requestedOutput);
  await mkdir(outputDirectory, { recursive: true });

  const port = await availablePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const serverOutput = [];
  const vite = spawn(
    npmExecutable,
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: WEB_DIRECTORY,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  vite.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
  vite.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
  const outputText = () => serverOutput.join("").slice(-4000);
  let browser;
  try {
    await waitForServer(`${origin}/tournament-results-preview.html`, outputText);
    browser = await chromium.launch({ headless: true });
    for (const scenario of scenarios) {
      for (const layout of layouts) {
        for (const width of widths) {
          const page = await browser.newPage({
            viewport: { width: Math.max(width + 64, 480), height: 1400 },
          });
          try {
            const parameters = new URLSearchParams({
              scenario,
              layout,
              width: String(width),
              "card-breakpoint": String(breakpoint),
            });
            await page.goto(`${origin}/tournament-results-preview.html?${parameters.toString()}`);
            await page.locator('body[data-preview-ready="true"]').waitFor();
            const error = page.locator(".preview-error");
            if (await error.count() > 0) throw new Error(await error.first().innerText());
            const path = join(outputDirectory, `${scenario}-${layout}-${String(width)}.png`);
            await page.locator("#preview-capture").screenshot({ path, animations: "disabled" });
            console.log(path);
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser?.close();
    stopServer(vite);
  }
}

await main();
