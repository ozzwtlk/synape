import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { execText } from './adapters/proc.ts';

/** Strip the IPv4-mapped prefix Node reports on dual-stack sockets. */
export const normalizeAddr = (a = '') => a.replace(/^::ffff:/i, '');

export const isLoopback = (addr: string) => {
  const a = normalizeAddr(addr);
  return a === '::1' || a.startsWith('127.');
};

/**
 * Addresses that can only come from this machine, the LAN or a tailnet:
 * loopback, RFC 1918, link-local, CGNAT 100.64/10 (Tailscale) and IPv6
 * ULA / link-local (Tailscale uses fd7a:115c:a1e0::/48). Everything else is
 * refused even before authentication.
 */
export function isPrivateAddress(addr: string): boolean {
  const a = normalizeAddr(addr).toLowerCase();
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127);
  }
  if (isIP(a) === 6) return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  return false;
}

/** Hostname part of a Host header ("[::1]:7420" → "::1"). */
export function hostOf(header: string) {
  const m = header.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (m) return m[1];
  return header.replace(/:\d+$/, '');
}

/**
 * Persistent access token for non-loopback clients. Kept in the data dir
 * (mode 0600) so links opened on a phone/laptop keep working across restarts.
 */
export function accessToken(dataDir: string, rotate = false): string {
  const f = join(dataDir, 'access-token');
  if (!rotate && existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(dataDir, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(f, `${t}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}

export function sameSecret(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookie(req: { headers: { cookie?: string } }, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export interface ReachableUrl {
  label: string;
  url: string;
}

/** URLs other devices can use: Tailscale (MagicDNS name and IP) first, then LAN. */
export async function reachableUrls(port: number, bindHost: string): Promise<ReachableUrl[]> {
  const out: ReachableUrl[] = [];
  const loopbackOnly = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  if (loopbackOnly) return out;
  const ts = await execText('tailscale', ['status', '--json'], process.cwd(), 2500).catch(() => undefined);
  if (ts?.code === 0) {
    try {
      const self = JSON.parse(ts.stdout).Self;
      const dns = String(self?.DNSName ?? '').replace(/\.$/, '');
      if (dns) out.push({ label: 'tailscale', url: `http://${dns}:${port}` });
    } catch {}
  }
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4' || !isPrivateAddress(a.address)) continue;
      if (bindHost !== '0.0.0.0' && bindHost !== '::' && bindHost !== a.address) continue;
      out.push({ label: /^tailscale|^ts/.test(name) || a.address.startsWith('100.') ? 'tailscale' : `lan (${name})`, url: `http://${a.address}:${port}` });
    }
  }
  return out;
}

export const machineName = () => hostname().toLowerCase();
