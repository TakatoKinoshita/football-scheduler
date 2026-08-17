import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const WEB_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE_FIXTURE_IDS = ["day1-league", "day2-same-rank", "day2-tournament"];
const LEAGUE_RESULTS_FIXTURE_IDS = [
  "league-results-normal-2",
  "league-results-direct-4",
  "league-results-mini-league-4",
  "league-results-residual-draw-5",
  "league-results-all-draws-4",
  "league-results-multiple-blocks-long-names",
  "league-results-normal-8",
  "league-results-normal-16",
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedFixtures() {
  const fixtureSet = option("--fixture-set") ?? "schedule";
  const fixtureIds = fixtureSet === "schedule"
    ? SCHEDULE_FIXTURE_IDS
    : fixtureSet === "league-results"
      ? LEAGUE_RESULTS_FIXTURE_IDS
      : (() => { throw new Error(`未対応のExcel fixture setです: ${fixtureSet}`); })();
  const requested = option("--fixture") ?? "all";
  if (requested === "all") return fixtureIds;
  if (!fixtureIds.includes(requested)) throw new Error(`未対応のExcel fixtureです: ${requested}`);
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
    throw new Error("ローカルExcelプレビュー用ポートを確保できませんでした。");
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
  const fixtures = selectedFixtures();
  const requestedOutput = option("--output-dir");
  const outputDirectory = requestedOutput === undefined
    ? await mkdtemp(join(tmpdir(), "football-scheduler-excel-previews-"))
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
      env: { ...process.env, TZ: "Asia/Tokyo" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  vite.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
  vite.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
  const outputText = () => serverOutput.join("").slice(-4000);
  let browser;
  try {
    await waitForServer(`${origin}/excel-preview.html`, outputText);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    for (const fixture of fixtures) {
      const parameters = new URLSearchParams({ fixture });
      await page.goto(`${origin}/excel-preview.html?${parameters.toString()}`);
      await page.locator('body[data-preview-ready="true"]').waitFor();
      const status = await page.locator("body").getAttribute("data-preview-status");
      if (status !== "ready") {
        throw new Error(await page.locator("#excel-preview-error").innerText());
      }
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#excel-preview-download").click();
      const download = await downloadPromise;
      const outputPath = join(outputDirectory, `${fixture}.xlsx`);
      await download.saveAs(outputPath);
      console.log(outputPath);
    }
    await page.close();
  } finally {
    await browser?.close();
    stopServer(vite);
  }
}

await main();
