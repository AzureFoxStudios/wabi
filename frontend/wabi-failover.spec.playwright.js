import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

test('guest client rotates backend after tim goes down', async ({ page }) => {
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));

  let backendStopped = false;
  try {
    const frontendUrl = 'http://100.96.11.45:3000';
    const username = `smoke${Date.now().toString().slice(-6)}`;

    await page.goto(frontendUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await expect(page.locator('text=Connect to Wabi Domain')).toHaveCount(0);

    await page.locator('input[type="text"]').first().fill(username);
    await page.locator('button.join-btn').first().click();

    await page.waitForTimeout(5000);

    const before = await page.evaluate(() => ({
      href: window.location.href,
      storedServerUrl: localStorage.getItem('wabi.serverUrl'),
      remembered: localStorage.getItem('wabi.serverUrlRemember'),
      sessionUrl: sessionStorage.getItem('wabi.serverUrlSession'),
      storageKeys: Object.keys(localStorage),
      bodyText: document.body.innerText.slice(0, 400)
    }));

    execSync("ssh -o BatchMode=yes tim@100.96.11.45 'cd /home/tim/wabi && docker compose stop backend'", { stdio: 'pipe' });
    backendStopped = true;

    let after = null;
    await expect
      .poll(
        async () => {
          after = await page.evaluate(() => ({
            storedServerUrl: localStorage.getItem('wabi.serverUrl'),
            remembered: localStorage.getItem('wabi.serverUrlRemember'),
            sessionUrl: sessionStorage.getItem('wabi.serverUrlSession'),
            bodyText: document.body.innerText.slice(0, 400)
          }));
          return after.storedServerUrl || '';
        },
        { timeout: 45000, intervals: [1000, 2000, 2000, 3000] }
      )
      .not.toBe('http://100.96.11.45:8080');

    console.log(JSON.stringify({ before, after, logs: logs.slice(-120) }, null, 2));
    expect(after.storedServerUrl).toMatch(/^http:\/\/(100\.87\.255\.66|100\.104\.166\.42):8080$/);
  } finally {
    if (backendStopped) {
      execSync("ssh -o BatchMode=yes tim@100.96.11.45 'cd /home/tim/wabi && docker compose start backend'", { stdio: 'pipe' });
    }
  }
});
