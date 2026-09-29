import { test, expect } from '@playwright/test';
import { bookContent } from '../src/content.js';
const sheetCount = bookContent.sheets.length;
const screenshots = `stories/${bookContent.storyId}/qa/screenshots`;

async function settled(page, current) {
  await expect.poll(() => page.evaluate(() => window.bookDemo.state), { timeout: 20000 }).toMatchObject({ current, target: current, animating: false, dragging: false });
}

test('cover, page turns, queued navigation, autoplay and responsive view', async ({ page }) => {
  // Walks all 11 sheets, plays narration and takes 7 screenshots: more than the 45 s config default.
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173');
  await expect(page.locator('canvas')).toBeVisible();
  await settled(page, 0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${screenshots}/desktop-cover.png` });
  await expect(page.locator('#prev')).toBeDisabled();
  await page.locator('#next').click();
  await page.waitForTimeout(650);
  await page.screenshot({ path: `${screenshots}/turning.png` });
  await settled(page, 1);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${screenshots}/desktop-open.png` });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const queuedPage = Math.min(3, sheetCount);
  await settled(page, queuedPage);
  await expect(page.locator('#chapter')).toHaveText(bookContent.chapters[queuedPage]);
  for (let state = queuedPage + 1; state <= sheetCount; state++) {
    await page.locator('#next').click();
    await settled(page, state);
  }
  await expect(page.locator('#next')).toBeDisabled();
  await page.screenshot({ path: `${screenshots}/back-cover.png` });
  await page.locator('#reset').click();
  await settled(page, 0);
  await page.locator('#play').click();
  await settled(page, 1);
  await page.locator('#play').click();
  expect(await page.evaluate(() => window.bookDemo.state.autoplay)).toBe(false);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${screenshots}/landscape-open.png` });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${screenshots}/landscape-small.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${screenshots}/mobile-open.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('ArrowLeft');
  await settled(page, 0);
  expect(errors).toEqual([]);
});

test('dragging completes or springs back; cover can be clicked', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await settled(page, 0);
  await page.waitForTimeout(1000);
  await page.mouse.click(735, 490);
  await settled(page, 1);
  await page.waitForTimeout(1000);
  await page.mouse.move(960, 490);
  await page.mouse.down();
  expect(await page.evaluate(() => window.bookDemo.state.dragging)).toBe(true);
  await page.mouse.move(940, 490, { steps: 5 });
  await page.mouse.up();
  await settled(page, 1);
  await page.mouse.move(960, 490);
  await page.mouse.down();
  await page.mouse.move(600, 490, { steps: 12 });
  await page.mouse.up();
  await settled(page, 2);
  await page.mouse.move(500, 490);
  await page.mouse.down();
  await page.mouse.move(850, 490, { steps: 12 });
  await page.mouse.up();
  await settled(page, 1);
});


test('illustrated pages load and every story state is reviewable in landscape', async ({ page }) => {
  // 22 base64 page documents at two landscape viewports: this needs more than 75 s on a laptop.
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning' && message.text().includes('图片加载失败')) errors.push(message.text()); });
  await page.goto('http://127.0.0.1:5173');
  const images = bookContent.sheets.flatMap(sheet => [sheet.front.image, sheet.back.image]).filter(Boolean);
  const decoded = await page.evaluate(async (urls) => {
    return Promise.all(urls.map(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1400;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      // The lower panel must contain actual English pixels, not just an image field in JSON.
      const pixels = context.getImageData(0, 950, 1024, 420).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 120 && pixels[i + 2] < 140) ink++;
      return { url, width: image.naturalWidth, height: image.naturalHeight, ink, exportable: canvas.toDataURL().startsWith('data:image/png') };
    }));
  }, images);
  expect(decoded).toHaveLength(sheetCount * 2);
  for (const item of decoded) {
    expect(item.width).toBe(1024); expect(item.height).toBe(1400);
    expect(item.ink).toBeGreaterThan(500); expect(item.exportable).toBe(true);
  }
  await expect(page.locator('.page-dot')).toHaveCount(sheetCount + 1);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (let state = 0; state <= sheetCount; state++) {
      await page.evaluate(state => window.bookDemo.goTo(state), state);
      await settled(page, state);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${screenshots}/story-${viewport.width}-${state}.png` });
    }
  }
  expect(errors).toEqual([]);
});
