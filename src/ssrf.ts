/**
 * SSRF guard — bảo vệ fetch_url khỏi truy cập internal/metadata endpoints.
 *
 * Bot chạy trong container/Docker — attacker có thể lừa AI gọi URL trỏ tới
 * `http://127.0.0.1:port` (internal service) hoặc `http://169.254.169.254/...`
 * (cloud IMDS — Instance Metadata Service, leak credentials AWS/GCP/Azure).
 *
 * 2 chế độ:
 *   - `assertSafeUrl` (sync, IP-literal only) — cho web_search (URL DDG hard-coded public)
 *   - `validateRemoteUrl` + `fetchRemoteUrl` (async, DNS-resolve + redirect re-check)
 *     — cho fetch_url (chống DNS-rebind + redirect-to-internal)
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/** Parse IPv4 literal → [a,b,c,d]. Null nếu không hợp lệ. */
function parseIpv4(s: string): [number, number, number, number] | null {
	const parts = s.split(".");
	if (parts.length !== 4) return null;
	const octets: [number, number, number, number] = [0, 0, 0, 0];
	for (let i = 0; i < 4; i++) {
		const p = parts[i];
		if (!p || !/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		octets[i] = n;
	}
	return octets;
}

/** Check IPv4 literal có thuộc private/loopback/link-local range không. */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
	const [a, b] = octets;
	// 10.0.0.0/8 — private class A
	if (a === 10) return true;
	// 127.0.0.0/8 — loopback
	if (a === 127) return true;
	// 169.254.0.0/16 — link-local + AWS/GCP/Azure IMDS (169.254.169.254)
	if (a === 169 && b === 254) return true;
	// 172.16.0.0/12 — private (172.16.x – 172.31.x)
	if (a === 172 && b >= 16 && b <= 31) return true;
	// 192.168.0.0/16 — private
	if (a === 192 && b === 168) return true;
	// 0.0.0.0/8 — "this network" (reserved, sometimes proxy-bypass target)
	if (a === 0) return true;
	return false;
}

/**
 * Check hostname có phải IP literal trong private/loopback/link-local range.
 *
 * @param hostname — URL.hostname (lowercase, không có port, không có brackets cho IPv6)
 * @returns true nếu private/loopback/link-local
 *
 * Examples:
 *   isPrivateHost("127.0.0.1") → true
 *   isPrivateHost("169.254.169.254") → true   ← IMDS critical
 *   isPrivateHost("8.8.8.8") → false
 *   isPrivateHost("example.com") → false       ← hostname, không phải IP
 *   isPrivateHost("::1") → true                ← IPv6 loopback
 *   isPrivateHost("fc00::1") → true            ← IPv6 ULA
 */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase();

	// IPv6 (URL.hostname bỏ dấu `[]`, nhưng Node/Bun có thể trả kèm — strip)
	const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;

	// IPv6 loopback
	if (v6 === "::1" || v6 === "0:0:0:0:0:0:0:1") return true;
	// IPv6 link-local fe80::/10
	if (
		v6.startsWith("fe8") ||
		v6.startsWith("fe9") ||
		v6.startsWith("fea") ||
		v6.startsWith("feb")
	) {
		return true;
	}
	// IPv6 unique-local fc00::/7 (fc.. và fd..)
	if (v6.startsWith("fc") || v6.startsWith("fd")) return true;

	// IPv4 literal
	const v4 = parseIpv4(h);
	if (v4) return isPrivateIpv4(v4);

	// Hostname (không phải IP literal) → coi như public. DNS-rebind là known limitation.
	return false;
}

/** Result của URL validation. */
export type UrlCheckResult =
	| { ok: true; url: URL }
	| { ok: false; error: string };

/**
 * Validate URL an toàn cho fetch_url.
 *
 * Rules:
 *   - Protocol ∈ {http, https}
 *   - Hostname có giá trị
 *   - Hostname không phải private/loopback/link-local IP literal
 *
 * @returns `{ ok: true, url }` nếu safe; `{ ok: false, error }` nếu block.
 */
export function assertSafeUrl(raw: string): UrlCheckResult {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: `Invalid URL: ${raw}` };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			ok: false,
			error: `Blocked protocol '${url.protocol}' — only http/https allowed`,
		};
	}

	if (!url.hostname) {
		return { ok: false, error: "URL missing hostname" };
	}

	if (isPrivateHost(url.hostname)) {
		return {
			ok: false,
			error: `Blocked private/internal host: ${url.hostname}`,
		};
	}

	return { ok: true, url };
}

const SSRF_MAX_REDIRECTS = 5;
const SSRF_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizeHostname(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

/**
 * Validate URL an toàn cho fetch remote — resolve DNS + check IP public.
 *
 * Mạnh hơn `assertSafeUrl` (sync, IP-literal only): resolve hostname rồi check
 * từng resolved IP — chống DNS-rebind (domain trỏ tới private IP).
 *
 * @throws Error nếu protocol sai / hostname internal / resolved IP private.
 * @returns URL nếu pass (không throw).
 */
export async function validateRemoteUrl(rawUrl: string | URL): Promise<URL> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
	}
	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}
	// IP literal → check trực tiếp (isPrivateHost cover v4 + v6 ranges)
	if (net.isIP(hostname)) {
		if (isPrivateHost(hostname))
			throw new Error(`Blocked internal address: ${hostname}`);
		return url;
	}
	// Hostname → resolve DNS, check mỗi resolved IP
	let addresses: { address: string; family: number }[];
	try {
		addresses = await dnsLookup(hostname, { all: true, verbatim: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}
	if (addresses.length === 0)
		throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) {
		if (isPrivateHost(address))
			throw new Error(`Blocked internal address for ${hostname}: ${address}`);
	}
	return url;
}

/**
 * Fetch URL với SSRF guard + redirect re-validation.
 *
 * Mỗi redirect (301/302/303/307/308) được validate lại qua `validateRemoteUrl`
 * trước khi follow — chống public-URL → 302 → internal-IP bypass.
 *
 * Bun native fetch (HTTP/2 auto). maxRedirects = 5.
 */
export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
): Promise<Response> {
	let current = await validateRemoteUrl(url);
	let requestInit = init;
	for (let redirects = 0; redirects <= SSRF_MAX_REDIRECTS; redirects++) {
		const response = await fetch(current, {
			...requestInit,
			redirect: "manual",
		});
		if (!SSRF_REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === SSRF_MAX_REDIRECTS) {
			throw new Error(`Too many redirects fetching ${current.toString()}`);
		}
		current = await validateRemoteUrl(new URL(location, current));
		// 303 / 301+302 (POST) → chuyển GET, bỏ body
		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				requestInit.method?.toUpperCase() === "POST")
		) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}
