import { expect, test, type Locator, type Page } from "@playwright/test";

const layouts = [
  "production-current",
  "compact-table",
  "integrated-status-table",
  "responsive-cards",
  "responsive-cards-quiet-table",
] as const;
const candidateLayouts = layouts.filter((layout) => layout !== "production-current");
const widths = [375, 768, 899, 900, 1002, 1280] as const;

async function openPreview(
  page: Page,
  options: {
    layout?: typeof layouts[number];
    scenario?: "mixed" | "winner-change";
    width?: typeof widths[number];
    cardBreakpoint?: number;
  } = {},
): Promise<void> {
  const width = options.width ?? 1280;
  await page.setViewportSize({ width: Math.max(width + 64, 480), height: 1000 });
  const parameters = new URLSearchParams({
    layout: options.layout ?? "integrated-status-table",
    scenario: options.scenario ?? "mixed",
    width: String(width),
    "card-breakpoint": String(options.cardBreakpoint ?? 899),
  });
  await page.goto(`/tournament-results-preview.html?${parameters.toString()}`);
  await page.locator('body[data-preview-ready="true"]').waitFor();
  await expect(page.locator(".preview-error")).toHaveCount(0);
  await expect(page.locator("#preview-output #tournament-results-input")).toBeVisible();
}

function entries(page: Page): Locator {
  return page.locator("#preview-output .tournament-result-entry[data-match-id]");
}

test("全layoutが同じ8試合を同じ順序で表示し、操作で切り替えてもdraftを保持する", async ({
  page,
}) => {
  await openPreview(page, { layout: "production-current" });
  const initialIds = await entries(page).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.matchId)
  );
  expect(initialIds).toHaveLength(8);

  const editable = entries(page).filter({ has: page.locator('input[data-score-field="regularHome"]:not(:disabled)') }).first();
  const matchId = await editable.getAttribute("data-match-id");
  expect(matchId).not.toBeNull();
  const regularHome = editable.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("12");
  await expect(regularHome).toHaveValue("12");

  for (const layout of candidateLayouts) {
    await page.locator("#preview-layout").selectOption(layout);
    await page.locator('body[data-preview-ready="true"]').waitFor();
    await expect(page.locator("#preview-output #tournament-results-input")).toHaveAttribute(
      "data-layout",
      layout,
    );
    expect(await entries(page).evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.matchId)
    )).toEqual(initialIds);
    await expect(
      page.locator(
        `#preview-output .tournament-result-entry[data-match-id="${matchId!}"] input[data-score-field="regularHome"]`,
      ),
    ).toHaveValue("12");
  }
});

for (const layout of candidateLayouts) {
  test(`${layout}は状態を文言で示し、待機行に得点inputを表示しない`, async ({ page }) => {
    await openPreview(page, { layout });
    const states = page.locator("#preview-output .tournament-result-state-label");
    for (const label of ["未入力", "入力中", "保存済", "要確認", "待機中"]) {
      const state = states.filter({ hasText: label }).first();
      if (layout === "responsive-cards-quiet-table") {
        await expect(state).toHaveClass(/results-preview-state-label--visually-hidden/u);
      } else await expect(state).toBeVisible();
    }

    const waiting = entries(page).filter({
      has: page.locator('.tournament-result-state-label[data-state="waiting"]'),
    });
    await expect(waiting.first()).toBeVisible();
    for (const entry of await waiting.all()) {
      await expect(entry.locator("input")).toHaveCount(0);
      expect((await entry.textContent())?.match(/前提試合の結果待ち/gu)).toHaveLength(1);
      await expect(entry.locator('[data-field="waiting-message"]')).toHaveText("—");
      await expect(entry.locator('.tournament-result-state-label[data-state="waiting"]'))
        .toHaveAttribute("aria-label", "前提試合待ち");
    }

    const invalidInput = page.locator('#preview-output input[aria-invalid="true"]').first();
    await expect(invalidInput).toBeVisible();
    const describedBy = await invalidInput.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy!}`)).not.toBeEmpty();
  });
}

test("状態バッジなし変種はテーブルだけバッジを隠し、カードでは表示する", async ({
  page,
}) => {
  await openPreview(page, {
    layout: "responsive-cards-quiet-table",
    width: 1002,
  });
  const tableStates = page.locator("#preview-output .tournament-result-state-label");
  expect(await tableStates.count()).toBeGreaterThan(0);
  for (const state of await tableStates.all()) {
    await expect(state).toHaveClass(/results-preview-state-label--visually-hidden/u);
    const box = await state.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(1);
    expect(box!.height).toBeLessThanOrEqual(1);
  }

  await page.locator("#preview-width").selectOption("768");
  await expect(page.locator("#preview-output .results-preview-card").first()).toBeVisible();
  await expect(
    page.locator("#preview-output .tournament-result-state-label", { hasText: "保存済" }).first(),
  ).toBeVisible();
  await expect(
    page.locator("#preview-output .tournament-result-state-label", { hasText: "保存済" }).first(),
  ).not.toHaveClass(/results-preview-state-label--visually-hidden/u);
});

test("同点の試合だけにPK入力を表示し、得点欄を対戦チーム込みで読み上げる", async ({ page }) => {
  await openPreview(page, { layout: "integrated-status-table" });
  const visiblePenalty = page.locator(
    '#preview-output input[data-score-field="penaltyHome"]:visible',
  );
  await expect(visiblePenalty.first()).toBeVisible();
  await expect(visiblePenalty.first()).toHaveAttribute("aria-label", /対.+PK得点/u);

  const allPenalty = page.locator('#preview-output input[data-score-field="penaltyHome"]');
  expect(await allPenalty.count()).toBeGreaterThan(await visiblePenalty.count());
  await expect(
    page.locator('#preview-output input[data-score-field="regularHome"]:visible').first(),
  ).toHaveAttribute("aria-label", /対.+通常得点/u);
});

test("推奨版は899px以下をカード、900px以上を横スクロールのない表にする", async ({
  page,
}) => {
  await openPreview(page, { layout: "responsive-cards", width: 899 });
  await expect(page.locator("#preview-output .results-preview-card").first()).toBeVisible();
  await expect(page.locator("#preview-output table")).toHaveCount(0);

  await openPreview(page, { layout: "responsive-cards", width: 900 });
  const wrapper = page.locator("#preview-output .results-preview-table-wrap");
  await expect(wrapper).toBeVisible();
  const dimensions = await wrapper.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("推奨版の表とカードがアクセシブルな名前・状態・コントラストを保つ", async ({
  page,
}) => {
  await openPreview(page, { layout: "responsive-cards", width: 900 });
  await expect(page.getByRole("table", { name: "2日目の試合結果入力・状態統合表" }))
    .toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(5);
  await expect(page.locator('[data-state="saved"]').first())
    .toHaveAttribute("aria-label", "保存済み");
  await expect(page.locator('[data-state="waiting"]').first())
    .toHaveAttribute("aria-label", "前提試合待ち");

  const contrastRatios = await page.locator(
    "#preview-output .tournament-result-state-label",
  ).evaluateAll((labels) => {
    const components = (value: string): [number, number, number, number] => {
      const numbers = value.match(/[\d.]+/gu)?.map(Number) ?? [];
      return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1];
    };
    const luminance = ([red, green, blue]: [number, number, number, number]): number => {
      const linear = [red, green, blue].map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    return labels.map((label) => {
      const foreground = components(getComputedStyle(label).color);
      let backgroundNode: Element | null = label;
      let background: [number, number, number, number] = [255, 255, 255, 1];
      while (backgroundNode !== null) {
        const candidate = components(getComputedStyle(backgroundNode).backgroundColor);
        if (candidate[3] > 0) {
          background = candidate;
          break;
        }
        backgroundNode = backgroundNode.parentElement;
      }
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    });
  });
  for (const ratio of contrastRatios) expect(ratio).toBeGreaterThanOrEqual(4.5);

  const invalid = page.locator('#preview-output input[aria-invalid="true"]').first();
  const errorId = await invalid.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  await expect(page.locator(`#${errorId!}`)).toBeVisible();
  await invalid.focus();
  expect(await invalid.evaluate((input) => Number.parseFloat(getComputedStyle(input).outlineWidth)))
    .toBeGreaterThanOrEqual(4);

  await openPreview(page, { layout: "responsive-cards", width: 899 });
  await expect(page.getByRole("list", { name: "2日目の試合結果入力" })).toBeVisible();
  await expect(page.getByRole("group", { name: "試合結果" }).first()).toBeVisible();
});

for (const width of widths) {
  for (const layout of candidateLayouts) {
    test(`${layout}を${String(width)}pxで表示してもページoverflowがなく操作対象が44px以上`, async ({
      page,
    }) => {
      await openPreview(page, { layout, width });
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

      const controls = page.locator(
        "#preview-output input:visible, #preview-output button:visible",
      );
      expect(await controls.count()).toBeGreaterThan(0);
      for (const control of await controls.all()) {
        const box = await control.boundingBox();
        expect(box, await control.getAttribute("aria-label") ?? "操作対象").not.toBeNull();
        expect(box!.height, await control.getAttribute("aria-label") ?? "操作対象").toBeGreaterThanOrEqual(44);
        expect(box!.width, await control.getAttribute("aria-label") ?? "操作対象").toBeGreaterThanOrEqual(44);
      }
    });
  }
}

test("視覚上の得点入力順とTab順が一致する", async ({ page }) => {
  for (const width of [375, 899, 900] as const) {
    await openPreview(page, { layout: "responsive-cards", width });
    const firstEntry = entries(page).filter({
      has: page.locator('input[data-score-field="penaltyHome"]:visible'),
    }).first();
    const fields = firstEntry.locator("input:visible");
    expect(await fields.count()).toBeGreaterThanOrEqual(4);
    const orderedFields = await fields.evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).dataset.scoreField)
    );
    expect(orderedFields.slice(0, 4)).toEqual([
      "regularHome",
      "regularAway",
      "penaltyHome",
      "penaltyAway",
    ]);
    await fields.first().focus();
    for (const expected of orderedFields.slice(1)) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.dataset.scoreField
      )).toBe(expected);
    }
  }
});

for (const [layout, width] of [
  ["responsive-cards", 375],
  ["integrated-status-table", 1002],
  ["responsive-cards-quiet-table", 1002],
] as const) {
  test(`${layout}の得点区切りを左右入力欄の中間に置く`, async ({ page }) => {
    await openPreview(page, { layout, width });
    const pair = page.locator("#preview-output .results-preview-score-pair:visible").first();
    const geometry = await pair.evaluate((element) => {
      const home = element.children[0]!.getBoundingClientRect();
      const separator = element.children[1]!.getBoundingClientRect();
      const away = element.children[2]!.getBoundingClientRect();
      return {
        pairWidth: element.getBoundingClientRect().width,
        separatorCenter: separator.left + separator.width / 2,
        gapCenter: (home.right + away.left) / 2,
      };
    });
    expect(geometry.pairWidth).toBeLessThan(200);
    expect(Math.abs(geometry.separatorCenter - geometry.gapCenter)).toBeLessThan(1);
  });
}

test("scenario、表示幅、カード切替幅をquery parameterと画面操作から変更できる", async ({
  page,
}) => {
  await openPreview(page, {
    layout: "responsive-cards",
    scenario: "winner-change",
    width: 768,
    cardBreakpoint: 900,
  });
  await expect(page.locator("#preview-layout")).toHaveValue("responsive-cards");
  await expect(page.locator("#preview-scenario")).toHaveValue("winner-change");
  await expect(page.locator("#preview-width")).toHaveValue("768");
  await expect(page.locator("#preview-card-breakpoint")).toHaveValue("900");

  await page.locator("#preview-scenario").selectOption("mixed");
  await page.locator('body[data-preview-ready="true"]').waitFor();
  expect(new URL(page.url()).searchParams.get("scenario")).toBe("mixed");
});

test("勝者変更では影響する後続結果だけを取り消す", async ({ page }) => {
  await openPreview(page, {
    layout: "integrated-status-table",
    scenario: "winner-change",
  });
  const opening = page.locator(
    '#preview-output .tournament-result-entry[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  await opening.locator('input[data-score-field="regularHome"]').fill("0");
  const away = opening.locator('input[data-score-field="regularAway"]');
  await away.fill("3");
  await away.press("Tab");

  await expect(page.locator("#preview-announcement")).toContainText("後続2試合を取り消しました");
  for (const matchId of ["PT-1-RANK-1-2-M1", "PT-1-RANK-3-4-M1"]) {
    const affected = page.locator(
      `#preview-output .tournament-result-entry[data-match-id="${matchId}"]`,
    );
    await expect(affected.locator(".tournament-result-state-label")).toHaveText("未入力");
    const scores = affected.locator("input[data-score-field]");
    await expect(scores).toHaveCount(4);
    for (const score of await scores.all()) await expect(score).toHaveValue("");
  }
  for (const matchId of ["PT-2-RANK-5-6-M1", "PT-2-RANK-7-8-M1"]) {
    await expect(page.locator(
      `#preview-output .tournament-result-entry[data-match-id="${matchId}"] .tournament-result-state-label`,
    )).toHaveText("保存済");
  }
});
