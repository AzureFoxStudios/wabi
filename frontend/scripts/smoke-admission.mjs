// Disposable Authorities in smokes that register several members directly over HTTP.
//
// With an owner and no saved admission policy, the server admits by invitation only
// (core/crates/wabi-server/src/api/auth.rs, `unsaved_admission_policy`). These smokes test other
// things, so they save an explicit Open policy before the server starts, as an owner would on
// the setup screen. browser-invites-smoke.mjs deliberately does not: it tests the default.
import { mkdirSync, writeFileSync } from 'node:fs';

export function saveOpenAdmission(dataDir) {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(`${dataDir}/admin_policies.json`, JSON.stringify({
		auth_policy: { mode: 'open', allowRegister: true, allowGuest: true, emailVerifyRequired: false }
	}), { mode: 0o600 });
}
