import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const WEB_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_IDS = [
  "day1-league-16",
  "day2-same-rank-16-provisional",
  "day2-same-rank-16-resolved",
  "day2-tournament-16-provisional",
  "day2-tournament-16-resolved",
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedFixtures() {
  const requested = option("--fixture") ?? "all";
  if (requested === "all") return FIXTURE_IDS;
  if (!FIXTURE_IDS.includes(requested)) throw new Error(`未対応の印刷fixtureです: ${requested}`);
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
    throw new Error("ローカル印刷プレビュー用ポートを確保できませんでした。");
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
    ? await mkdtemp(join(tmpdir(), "football-scheduler-print-previews-"))
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
    await waitForServer(`${origin}/print-preview.html`, outputText);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1440, height: 1200 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    for (const fixture of fixtures) {
      const parameters = new URLSearchParams({ fixture });
      await page.goto(`${origin}/print-preview.html?${parameters.toString()}`);
      await page.locator('body[data-preview-ready="true"]').waitFor();
      const status = await page.locator("body").getAttribute("data-preview-status");
      if (status !== "ready") {
        const message = await page.locator("#print-preview-error").innerText();
        throw new Error(message || `印刷fixture「${fixture}」を表示できませんでした。`);
      }
      const path = join(outputDirectory, `${fixture}.pdf`);
      await page.pdf({
        path,
        format: "A4",
        margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        tagged: true,
      });
      console.log(path);
    }
    await context.close();
  } finally {
    await browser?.close();
    stopServer(vite);
  }
}

await main();
