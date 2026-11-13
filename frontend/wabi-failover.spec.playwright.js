import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

// Manual field test against a real multi-host deployment; not run in CI.
// Every host is supplied by the operator, nothing is hard-coded:
//   WABI_FAILOVER_PRIMARY_HOST   host/IP of the primary (e.g. 192.0.2.10)
//   WABI_FAILOVER_SSH            ssh target that controls the primary (e.g. operator@192.0.2.10)
//   WABI_FAILOVER_REMOTE_DIR     Wabi checkout on the primary (e.g. /home/operator/wabi)
//   WABI_FAILOVER_STANDBY_HOSTS  comma-separated standby hosts (e.g. 192.0.2.20,192.0.2.30)
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for this manual failover test (see the header comment)`);
  return value;
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('guest client rotates backend after the primary goes down', async ({ page }) => {
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));

  const primaryHost = requiredEnv('WABI_FAILOVER_PRIMARY_HOST');
  const sshTarget = requiredEnv('WABI_FAILOVER_SSH');
  const remoteDir = requiredEnv('WABI_FAILOVER_REMOTE_DIR');
  const standbyHosts = requiredEnv('WABI_FAILOVER_STANDBY_HOSTS').split(',').map((host) => host.trim()).filter(Boolean);
  const compose = (action) => `ssh -o BatchMode=yes ${sshTarget} 'cd ${remoteDir} && docker compose ${action} backend'`;

  let backendStopped = false;
  try {
    const frontendUrl = `http://${primaryHost}:3000`;
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

    execSync(compose('stop'), { stdio: 'pipe' });
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
      .not.toBe(`http://${primaryHost}:8080`);

    console.log(JSON.stringify({ before, after, logs: logs.slice(-120) }, null, 2));
    expect(after.storedServerUrl).toMatch(new RegExp(`^http://(${standbyHosts.map(escapeRegExp).join('|')}):8080$`));
  } finally {
    if (backendStopped) {
      execSync(compose('start'), { stdio: 'pipe' });
    }
  }
});
