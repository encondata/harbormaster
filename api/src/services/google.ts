// Minimal Google Sheets client using a service account (no SDK): sign a JWT, swap it for an
// access token, then call the Sheets REST API.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { badRequest, HttpError } from '../errors.js';

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export async function loadServiceAccount(): Promise<ServiceAccount | null> {
  try {
    const raw = JSON.parse(await readFile(config.googleServiceAccountFile, 'utf8'));
    if (!raw.client_email || !raw.private_key) return null;
    return raw;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Builds the signed JWT the token endpoint expects. Exported for tests. */
export function signedAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

let cached: { token: string; expires: number } | null = null;

async function accessToken(sa: ServiceAccount) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(sa) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new HttpError(502, `Google sign-in failed: ${data.error_description ?? data.error ?? res.status}`, 'google_auth');
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export function parseSpreadsheetId(input: string): string {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  throw badRequest('Paste the Google Sheet link (https://docs.google.com/spreadsheets/d/…) or its ID');
}

export class Sheets {
  private constructor(private token: string, private id: string) {}

  static async open(spreadsheetId: string) {
    const sa = await loadServiceAccount();
    if (!sa) throw badRequest('No Google service account is configured on the server (see docs/SHEET-EXPORT.md)');
    return new Sheets(await accessToken(sa), spreadsheetId);
  }

  private async call(method: string, path: string, body?: unknown) {
    // GOOGLE_SHEETS_API exists only to point tests at a stand-in server.
    const base = process.env.GOOGLE_SHEETS_API ?? 'https://sheets.googleapis.com';
    const res = await fetch(`${base}/v4/spreadsheets/${this.id}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 404) {
        const sa = await loadServiceAccount();
        throw new HttpError(502, `Google refused access to the sheet (${msg}). Share it with ${sa?.client_email ?? 'the service account'} as an Editor.`, 'google_access');
      }
      throw new HttpError(502, `Google Sheets error: ${msg}`, 'google_error');
    }
    return data;
  }

  async tabs(): Promise<{ sheetId: number; title: string }[]> {
    const d = await this.call('GET', '?fields=sheets.properties(sheetId,title)');
    return (d.sheets ?? []).map((s: any) => s.properties);
  }

  /** Replace the contents of each named tab, creating tabs that don't exist yet. */
  async writeTabs(tabs: { title: string; rows: (string | number)[][] }[]) {
    let existing = await this.tabs();
    const missing = tabs.filter((t) => !existing.some((e) => e.title === t.title));
    if (missing.length) {
      await this.call('POST', ':batchUpdate', { requests: missing.map((t) => ({ addSheet: { properties: { title: t.title } } })) });
      existing = await this.tabs();
    }
    const a1 = (title: string) => `'${title.replace(/'/g, "''")}'`;
    await this.call('POST', '/values:batchClear', { ranges: tabs.map((t) => `${a1(t.title)}!A:ZZ`) });
    await this.call('POST', '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({ range: `${a1(t.title)}!A1`, values: t.rows })),
    });
    // Bold, frozen header row on each tab (row 1, or the row a tab marks as its header).
    await this.call('POST', ':batchUpdate', {
      requests: tabs.flatMap((t) => {
        const sheetId = existing.find((e) => e.title === t.title)!.sheetId;
        return [
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        ];
      }),
    });
  }
}
