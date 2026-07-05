/**
 * Unit tests cho SSRF guard.
 * Run: `bun test`
 */

import { describe, expect, test } from "bun:test";
import { isPrivateHost, assertSafeUrl } from "../src/ssrf.ts";

describe("isPrivateHost", () => {
  describe("IPv4 private/loopback/link-local", () => {
    test("blocks 127.0.0.0/8 loopback", () => {
      expect(isPrivateHost("127.0.0.1")).toBe(true);
      expect(isPrivateHost("127.1.2.3")).toBe(true);
      expect(isPrivateHost("127.255.255.254")).toBe(true);
    });

    test("blocks 10.0.0.0/8 private class A", () => {
      expect(isPrivateHost("10.0.0.1")).toBe(true);
      expect(isPrivateHost("10.255.255.255")).toBe(true);
    });

    test("blocks 192.168.0.0/16 private", () => {
      expect(isPrivateHost("192.168.0.1")).toBe(true);
      expect(isPrivateHost("192.168.1.100")).toBe(true);
    });

    test("blocks 172.16.0.0/12 private range", () => {
      // Lower boundary inclusive
      expect(isPrivateHost("172.16.0.1")).toBe(true);
      // Upper boundary inclusive
      expect(isPrivateHost("172.31.255.254")).toBe(true);
      // Mid-range
      expect(isPrivateHost("172.20.5.5")).toBe(true);
    });

    test("allows 172.x outside private range", () => {
      // 172.15.x — below range
      expect(isPrivateHost("172.15.0.1")).toBe(false);
      // 172.32.x — above range
      expect(isPrivateHost("172.32.0.1")).toBe(false);
    });

    test("blocks 169.254.0.0/16 link-local + IMDS", () => {
      // AWS/GCP/Azure Instance Metadata Service — critical to block
      expect(isPrivateHost("169.254.169.254")).toBe(true);
      expect(isPrivateHost("169.254.0.1")).toBe(true);
    });

    test("blocks 0.0.0.0/8 'this network' reserved", () => {
      expect(isPrivateHost("0.0.0.0")).toBe(true);
      expect(isPrivateHost("0.1.2.3")).toBe(true);
    });

    test("allows public IPv4", () => {
      expect(isPrivateHost("8.8.8.8")).toBe(false);
      expect(isPrivateHost("1.1.1.1")).toBe(false);
      expect(isPrivateHost("203.0.113.1")).toBe(false);
    });
  });

  describe("IPv6", () => {
    test("blocks loopback ::1", () => {
      expect(isPrivateHost("::1")).toBe(true);
      expect(isPrivateHost("0:0:0:0:0:0:0:1")).toBe(true);
    });

    test("blocks unique-local fc00::/7 (fc.. và fd..)", () => {
      expect(isPrivateHost("fc00::1")).toBe(true);
      expect(isPrivateHost("fd12:3456:789a::1")).toBe(true);
    });

    test("blocks link-local fe80::/10", () => {
      expect(isPrivateHost("fe80::1")).toBe(true);
      expect(isPrivateHost("fe9a::1")).toBe(true);
      expect(isPrivateHost("feba::1")).toBe(true);
    });

    test("allows public IPv6", () => {
      expect(isPrivateHost("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
    });

    test("strips [] brackets (URL.hostname edge case)", () => {
      expect(isPrivateHost("[::1]")).toBe(true);
      expect(isPrivateHost("[fc00::1]")).toBe(true);
    });
  });

  describe("hostname (không phải IP literal)", () => {
    test("treats hostnames as public (no DNS resolution)", () => {
      expect(isPrivateHost("example.com")).toBe(false);
      expect(isPrivateHost("npmjs.com")).toBe(false);
      expect(isPrivateHost("localhost")).toBe(false); // Known limitation — hostname không resolve
      expect(isPrivateHost("metadata.google.internal")).toBe(false); // Same — known limitation
    });
  });

  describe("invalid input", () => {
    test("rejects malformed strings", () => {
      expect(isPrivateHost("not.an.ip")).toBe(false);
      expect(isPrivateHost("999.999.999.999")).toBe(false);
      expect(isPrivateHost("")).toBe(false);
    });
  });
});

describe("assertSafeUrl", () => {
  test("accepts https URLs", () => {
    const r = assertSafeUrl("https://example.com/path?q=1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
  });

  test("accepts http URLs (public)", () => {
    const r = assertSafeUrl("http://example.com/");
    expect(r.ok).toBe(true);
  });

  test("blocks file:// protocol", () => {
    const r = assertSafeUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("protocol");
  });

  test("blocks ftp:// protocol", () => {
    const r = assertSafeUrl("ftp://example.com/file");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("protocol");
  });

  test("blocks gopher:// protocol (SSRF classic)", () => {
    const r = assertSafeUrl("gopher://127.0.0.1:6379/_FLUSHALL");
    expect(r.ok).toBe(false);
  });

  test("blocks http://127.0.0.1 (loopback)", () => {
    const r = assertSafeUrl("http://127.0.0.1:8080/admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("private");
  });

  test("blocks http://169.254.169.254 (IMDS — critical)", () => {
    const r = assertSafeUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("169.254.169.254");
  });

  test("blocks http://192.168.x.x (private)", () => {
    const r = assertSafeUrl("http://192.168.1.1/");
    expect(r.ok).toBe(false);
  });

  test("blocks http://[::1]/ (IPv6 loopback)", () => {
    const r = assertSafeUrl("http://[::1]:3000/");
    expect(r.ok).toBe(false);
  });

  test("blocks invalid URL string", () => {
    const r = assertSafeUrl("not-a-url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid");
  });

  test("blocks empty string", () => {
    const r = assertSafeUrl("");
    expect(r.ok).toBe(false);
  });

  test("accepts https với port (public IP)", () => {
    const r = assertSafeUrl("https://1.1.1.1:8443/");
    expect(r.ok).toBe(true);
  });
});
