import { getApiBase, fetchWithTimeout } from './utils';

export interface LoreRepo {
	channelId: number;
	repoName: string;
	createdBy: number;
	createdAt: number;
}

export interface LoreFileInfo {
	path: string;
	size: number;
	modifiedAt: number;
	lockedBy: number | null;
}

export interface LoreRevision {
	hash: string;
	message: string;
	authorId: number;
	timestamp: number;
}

export interface LoreBranch {
	name: string;
}

export function loreUrl(path: string): string {
	// Server mounts lore under /api/addons/lore (main.rs nest /api + addons nest)
	return `${getApiBase()}/api/addons/lore${path}`;
}

/**
 * Parse a Wabi channel id string (`ch_{hex}`) into the numeric i64 the Lore
 * API path expects. Server assigns ids as format!("ch_{:x}", commit_seq).
 * Accepts plain decimal digits too for safety.
 */
export function parseLoreChannelId(chId: string | null | undefined): number | null {
	if (!chId) return null;
	const match = chId.match(/^ch_([0-9a-fA-F]+)$/);
	if (!match) return null;
	const n = Number.parseInt(match[1], 16);
	return Number.isFinite(n) ? n : null;
}

/** Authenticated media URL builder (L3). Prefer blob previews (L5) for <img>/<video>. */
export function loreFileUrl(channelId: number, path: string, revision?: string): string {
	const params = new URLSearchParams();
	if (revision) params.set('revision', revision);
	const qs = params.toString();
	const base = loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`);
	return qs ? `${base}?${qs}` : base;
}

export async function getLoreRepo(token: string, channelId: number): Promise<LoreRepo | null> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get lore repo');
	}
	return (await res.json()) as LoreRepo;
}

export async function createLoreRepo(token: string, channelId: number, repoName: string): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl('/repos'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ channelId, repoName })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create lore repo');
	}
	return (await res.json()) as LoreRepo;
}

export async function deleteLoreRepo(token: string, channelId: number): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to delete lore repo');
	}
}

export async function uploadLoreFile(
	token: string,
	channelId: number,
	path: string,
	file: File,
	message?: string
): Promise<{ revision: LoreRevision; file: LoreFileInfo }> {
	const params = new URLSearchParams();
	if (message) params.set('message', message);
	if (path) params.set('repo_path', path);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/octet-stream'
		},
		body: await file.arrayBuffer()
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to upload file');
	}
	return (await res.json()) as { revision: LoreRevision; file: LoreFileInfo };
}

export async function listLoreFiles(token: string, channelId: number, prefix?: string): Promise<LoreFileInfo[]> {
	const params = new URLSearchParams();
	if (prefix) params.set('prefix', prefix);
	const url = `${loreUrl(`/repos/${channelId}/files`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to list files');
	}
	return (await res.json()) as LoreFileInfo[];
}

export async function downloadLoreFile(
	token: string,
	channelId: number,
	path: string,
	revision?: string
): Promise<Blob> {
	const params = new URLSearchParams();
	if (revision) params.set('revision', revision);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to download file');
	}
	return await res.blob();
}

export async function getSignedLoreUrl(
	token: string,
	channelId: number,
	path: string,
	revision?: string,
	expires?: number
): Promise<string> {
	const params = new URLSearchParams({ path });
	if (revision) params.set('revision', revision);
	if (expires) params.set('expires', String(expires));
	const url = `${loreUrl(`/repos/${channelId}/signed-url`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create signed URL');
	}
	const payload = (await res.json()) as { url?: string; expiresAt?: number };
	if (!payload.url) throw new Error('Signed URL response missing url');
	return payload.url;
}

export async function deleteLoreFile(token: string, channelId: number, path: string, message?: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`), {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message: message || '' })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to delete file');
	}
}

export async function lockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/lock/${encodeURIComponent(path)}`), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to lock file');
	}
}

export async function unlockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/lock/${encodeURIComponent(path)}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to unlock file');
	}
}

export async function getLoreFileHistory(token: string, channelId: number, path: string): Promise<LoreRevision[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/history/${encodeURIComponent(path)}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get file history');
	}
	return (await res.json()) as LoreRevision[];
}

export async function getLoreFileDiff(token: string, channelId: number, path: string, from: string, to: string): Promise<string> {
	const params = new URLSearchParams({ from, to });
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/diff/${encodeURIComponent(path)}?${params.toString()}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get file diff');
	}
	return await res.text();
}

export async function getLoreRepoHistory(token: string, channelId: number): Promise<LoreRevision[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/history`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get repo history');
	}
	return (await res.json()) as LoreRevision[];
}

export async function getLoreBranches(token: string, channelId: number): Promise<LoreBranch[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to list branches');
	}
	const data = (await res.json()) as { branches: string[] };
	return (data.branches || []).map((name) => ({ name }));
}

export async function createLoreBranch(token: string, channelId: number, name: string, baseRevision?: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ name, baseRevision: baseRevision || null })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create branch');
	}
}

export async function mergeLoreBranch(token: string, channelId: number, branchName: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches/${encodeURIComponent(branchName)}/merge`), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to merge branch');
	}
}

export async function createLoreSnapshot(token: string, channelId: number, message: string): Promise<LoreRevision> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/snapshot`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create snapshot');
	}
	return (await res.json()) as LoreRevision;
}

export async function checkLoreHealth(token: string): Promise<{ status: string }> {
	const res = await fetchWithTimeout(loreUrl('/health'), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		return { status: 'error' };
	}
	return (await res.json()) as { status: string };
}

// ============================================================================
// W6b: External-tool Connect — per-channel connection config + setup snippets
// ============================================================================

export interface LoreConnectConfig {
	serverUrl: string;
	repoId: string;
	token: string;
}

export interface LoreConnectSnippet {
	lang: string;
	label: string;
	code: string;
}

const LORE_CONNECT_STORAGE_PREFIX = 'wabi:lore:connect:';

export function loreConnectStorageKey(channelKey: string): string {
	return `${LORE_CONNECT_STORAGE_PREFIX}${channelKey}`;
}

export function loadLoreConnectConfig(channelKey: string): LoreConnectConfig | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(loreConnectStorageKey(channelKey));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<LoreConnectConfig>;
		return {
			serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
			repoId: typeof parsed.repoId === 'string' ? parsed.repoId : '',
			token: typeof parsed.token === 'string' ? parsed.token : ''
		};
	} catch {
		return null;
	}
}

export function saveLoreConnectConfig(channelKey: string, config: LoreConnectConfig): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(loreConnectStorageKey(channelKey), JSON.stringify(config));
	} catch {
		// Best effort only.
	}
}

export function generateLoreAccessToken(): string {
	const bytes = new Uint8Array(32);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fillLoreSnippet(template: string, server: string, repo: string, token: string, url: string): string {
	return template
		.replaceAll('__SERVER__', server)
		.replaceAll('__REPO__', repo)
		.replaceAll('__TOKEN__', token)
		.replaceAll('__URL__', url);
}

/** Pre-formatted, copyable setup snippets for external tools. */
export function buildLoreConnectSnippets(serverUrl: string, repoId: string, token: string): LoreConnectSnippet[] {
	const server = serverUrl.trim().replace(/\/+$/, '');
	const repo = repoId.trim() || '<repo>';
	const tok = token.trim() || '<token>';
	const url = `${server}/api/addons/lore/repos/${repo}/files`;

	const c = `#define SERVER "__SERVER__"
#define REPO "__REPO__"
#define TOKEN "__TOKEN__"

#include <stdio.h>
#include <string.h>
#include <curl/curl.h>

static size_t write_cb(void *ptr, size_t size, size_t nmemb, void *userdata) {
    return fwrite(ptr, size, nmemb, (FILE *)userdata);
}

int main(void) {
    CURL *curl = curl_easy_init();
    if (!curl) return 1;
    struct curl_slist *headers = NULL;
    char auth[256];
    snprintf(auth, sizeof auth, "Authorization: Bearer %s", TOKEN);
    headers = curl_slist_append(headers, auth);

    char url[512];
    snprintf(url, sizeof url, "%s/api/addons/lore/repos/%s/files", SERVER, REPO);

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, stdout);

    curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return 0;
}`;

	const cpp = `#define SERVER "__SERVER__"
#define REPO "__REPO__"
#define TOKEN "__TOKEN__"

#include <httplib.h>
#include <iostream>
#include <string>

int main() {
    httplib::Client cli(SERVER);
    httplib::Headers headers = {
        {"Authorization", "Bearer " + std::string(TOKEN)}
    };
    std::string path = "/api/addons/lore/repos/" + std::string(REPO) + "/files";
    auto res = cli.Get(path, headers);
    if (res && res->status == 200) {
        std::cout << res->body << std::endl;
    }
    return 0;
}`;

	const csharp = `using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;

class Program
{
    static async Task Main()
    {
        const string server = "__SERVER__";
        const string repo = "__REPO__";
        const string token = "__TOKEN__";

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

        string json = await client.GetStringAsync(
            $"{server}/api/addons/lore/repos/{repo}/files");
        Console.WriteLine(json);
    }
}`;

	const rust = `use reqwest::header::{AUTHORIZATION, HeaderValue};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = "__SERVER__";
    let repo = "__REPO__";
    let token = "__TOKEN__";

    let client = reqwest::Client::new();
    let json = client
        .get(format!("{server}/api/addons/lore/repos/{repo}/files"))
        .header(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}"))?)
        .send()
        .await?
        .text()
        .await?;
    println!("{json}");
    Ok(())
}`;

	const go = `package main

import (
	"fmt"
	"io"
	"net/http"
)

func main() {
	const server = "__SERVER__"
	const repo = "__REPO__"
	const token = "__TOKEN__"

	req, err := http.NewRequest("GET", server+"/api/addons/lore/repos/"+repo+"/files", nil)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Println(string(body))
}`;

	const python = `import requests

SERVER = "__SERVER__"
REPO = "__REPO__"
TOKEN = "__TOKEN__"

r = requests.get(
    "{{URL}}",
    headers={"Authorization": "Bearer " + TOKEN},
)
print(r.json())`.replace('{{URL}}', url);

	const js = `const SERVER = '__SERVER__';
const REPO = '__REPO__';
const TOKEN = '__TOKEN__';

const res = await fetch('__URL__', {
  headers: { Authorization: 'Bearer ' + TOKEN },
});
const files = await res.json();
console.log(files);`;

	const raw: { lang: string; label: string; code: string }[] = [
		{ lang: 'c', label: 'C (libcurl)', code: c },
		{ lang: 'cpp', label: 'C++ (cpp-httplib)', code: cpp },
		{ lang: 'csharp', label: 'C# (HttpClient)', code: csharp },
		{ lang: 'rust', label: 'Rust (reqwest)', code: rust },
		{ lang: 'go', label: 'Go (net/http)', code: go },
		{ lang: 'python', label: 'Python (requests)', code: python },
		{ lang: 'js', label: 'JavaScript (fetch)', code: js }
	];

	return raw.map((s) => ({ lang: s.lang, label: s.label, code: fillLoreSnippet(s.code, server, repo, tok, url) }));
}
