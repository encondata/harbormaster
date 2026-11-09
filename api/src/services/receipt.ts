// Kanban cards as tickets on an Epson-compatible ESC/POS receipt printer (80 mm paper), sent over raw TCP (port 9100).
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import sharp from 'sharp';
import { audit } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { publish } from '../events.js';
import { getObject } from '../storage.js';
import { cardsForPrint } from './cards.js';

/** Font A on 80 mm paper: 576 dots ÷ 12 dots per character. */
export const LINE_CHARS = 48;
const LOGO_MAX_W = 320;
const LOGO_MAX_H = 160;
const NOTES_MAX_LINES = 60;

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const cmd = (...bytes: number[]) => Buffer.from(bytes);
const INIT = cmd(ESC, 0x40, ESC, 0x74, 0x00); // reset, code page PC437
const align = (n: 0 | 1 | 2) => cmd(ESC, 0x61, n);
const bold = (on: boolean) => cmd(ESC, 0x45, on ? 1 : 0);
const size = (w: 1 | 2, h: 1 | 2) => cmd(GS, 0x21, ((w - 1) << 4) | (h - 1));
const feed = (lines: number) => cmd(ESC, 0x64, lines);
const CUT = cmd(GS, 0x56, 0x42, 0x00); // feed to the cutter, partial cut

/** The printer only has PC437, so keep to plain ASCII: drop accents, swap typographic punctuation. */
export function toAscii(s: string) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '*')
    .replace(/ /g, ' ')
    .replace(/\t/g, '  ')
    .replace(/[^\x0a\x20-\x7e]/g, '?');
}

/** Card descriptions are markdown; on paper we want just the words. */
function plainText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Word-wraps to `width` columns; the first line can be shorter (after a label). Long words are split. */
export function wrap(text: string, width: number, firstWidth = width): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    const max = () => (out.length === 0 ? firstWidth : width);
    for (let word of para.split(/ +/).filter(Boolean)) {
      while (word.length > max()) {
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, max()));
        word = word.slice(max());
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= max()) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** GS ( k: the printer draws the QR code itself, so it stays sharp. */
function qr(data: string, moduleSize = 6) {
  const d = Buffer.from(data, 'ascii');
  const len = d.length + 3;
  return Buffer.concat([
    cmd(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00), // model 2
    cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize),
    cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31), // error correction M
    cmd(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30), d,
    cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
  ]);
}

/**
 * GS v 0 raster of the logo. Thermal paper can't print grey, so the logo is lightened and then dithered,
 * which gives the same subdued look as the faint logo on the paper cards.
 */
async function logoRaster(png: Buffer) {
  const { data, info } = await sharp(png)
    .flatten({ background: '#ffffff' })
    .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = Float32Array.from(data, (v) => 255 - (255 - v) * 0.55); // 55% ink
  const bytesPerRow = Math.ceil(w / 8);
  const out = Buffer.alloc(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const black = px[i] < 128;
      if (black) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      const err = px[i] - (black ? 0 : 255); // Floyd–Steinberg
      if (x + 1 < w) px[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) px[i + w - 1] += (err * 3) / 16;
        px[i + w] += (err * 5) / 16;
        if (x + 1 < w) px[i + w + 1] += err / 16;
      }
    }
  }
  return Buffer.concat([cmd(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, h & 0xff, h >> 8), out]);
}

let defaultLogo: Promise<Buffer> | null = null;
/** The built-in H, used when the project has no logo of its own. */
export function defaultLogoPng() {
  defaultLogo ??= readFile(new URL('../../assets/card-logo.png', import.meta.url));
  return defaultLogo;
}

export type TicketCard = { key: string; title: string; description: string; area_name: string | null };

/** One card as a ticket: logo, key, System / Sub, rule, Notes, QR code, cut. */
export async function buildTicket(card: TicketCard, linkUrl: string, logoPng: Buffer | null): Promise<Buffer> {
  const text = (s: string) => Buffer.from(toAscii(s), 'ascii');
  const line = (s = '') => Buffer.concat([text(s), cmd(LF)]);
  const parts: Buffer[] = [INIT, align(1)];
  if (logoPng) {
    try {
      parts.push(await logoRaster(logoPng), cmd(LF));
    } catch {
      // A logo the printer can't use is not worth failing the print over.
    }
  }
  parts.push(bold(true), size(2, 2), line(card.key), size(1, 1), bold(false), align(0), line());

  const labelled = (label: string, value: string, big = false) => {
    const lines = wrap(toAscii(value), LINE_CHARS, LINE_CHARS - label.length - 1);
    parts.push(bold(false), text(`${label} `), bold(true), big ? size(1, 2) : size(1, 1));
    lines.forEach((l) => parts.push(line(l)));
    parts.push(size(1, 1), bold(false));
  };
  labelled('System:', card.area_name ?? '');
  labelled('Sub:', card.title, true);
  parts.push(line('-'.repeat(LINE_CHARS)), line('Notes:'));
  let notes = wrap(toAscii(plainText(card.description)), LINE_CHARS);
  if (notes.length > NOTES_MAX_LINES) notes = [...notes.slice(0, NOTES_MAX_LINES - 1), notes[NOTES_MAX_LINES - 1].slice(0, LINE_CHARS - 3) + '...'];
  if (notes.length === 1 && !notes[0]) notes = [];
  notes.forEach((l) => parts.push(line(l)));

  parts.push(line(), align(1), qr(linkUrl), cmd(LF), line(card.key), align(0), feed(3), CUT);
  return Buffer.concat(parts);
}

/** A short ticket to check the printer is reachable and the paper width is right. */
export function buildTestTicket(projectName: string) {
  const text = (s: string) => Buffer.from(toAscii(s) + '\n', 'ascii');
  return Buffer.concat([
    INIT, align(1), bold(true), size(2, 2), text('Harbor Master'), size(1, 1), bold(false),
    text(`Test print for ${projectName}`), align(0), text('-'.repeat(LINE_CHARS)),
    text('This line should fill the paper width exactly:'), text('0123456789'.repeat(5).slice(0, LINE_CHARS)),
    feed(3), CUT,
  ]);
}

/** Sends raw bytes to the printer's TCP port and waits until it has taken them. The address is re-checked here too. */
export function sendToPrinter(host: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  const addr = parsePrinterAddress(host, port);
  if ('error' in addr) return Promise.reject(badRequest(`The saved printer address isn't allowed: ${addr.error}`));
  return new Promise((resolve, reject) => {
    const fail = (why: string) => reject(new HttpError(502, `Couldn't print to ${addr.host}:${addr.port} (${why}). Check the printer is on and the address is right.`, 'printer_unreachable'));
    // An IP literal never needs DNS; refuse any lookup so nothing can turn into a different address.
    const lookup = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('DNS lookups are not allowed for printers'))) as unknown as net.LookupFunction;
    const sock = net.createConnection({ host: addr.host, port: addr.port, lookup });
    sock.setTimeout(timeoutMs, () => { sock.destroy(); fail('no answer'); });
    sock.once('error', (e: NodeJS.ErrnoException) => fail(e.code ?? e.message));
    sock.once('connect', () => sock.end(data));
    sock.once('close', (hadError) => { if (!hadError) resolve(); });
  });
}

/**
 * Printers live on the local network: a private IPv4 address and a raw printing port (9100–9109).
 * Only the strict dotted form is accepted (no leading zeros, which some resolvers read as octal), and the address
 * is rebuilt from its numbers, so what was checked is exactly what gets stored and connected to.
 */
export function parsePrinterAddress(host: string, port: number): { host: string; port: number } | { error: string } {
  const h = host.trim();
  if (!net.isIPv4(h)) return { error: 'Enter the printer\'s IP address, like 192.168.1.50' };
  const o = h.split('.').map(Number);
  const isPrivate = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  if (!isPrivate) return { error: 'The printer must be on your local network (an address starting 10., 172.16–31. or 192.168.)' };
  if (!Number.isInteger(port) || port < 9100 || port > 9109) return { error: 'Use the printer\'s raw printing port, normally 9100' };
  return { host: o.join('.'), port };
}

// ----- the project's receipt printer -----

export const MAX_TICKETS = 50;

type Printer = { name: string; host: string; port: number; logo_key: string | null };

async function projectPrinter(projectId: string): Promise<Printer> {
  const p = await one<{ name: string; receipt_printer_host: string | null; receipt_printer_port: number | null; logo_key: string | null }>(
    `select name, receipt_printer_host, receipt_printer_port, logo_key from projects where id = $1`, [projectId]);
  if (!p?.receipt_printer_host) throw badRequest('This project has no receipt printer. Add one in project Settings.');
  return { name: p.name, host: p.receipt_printer_host, port: p.receipt_printer_port ?? 9100, logo_key: p.logo_key };
}

export async function setReceiptPrinter(ctx: Ctx, projectId: string, printer: { host: string; port: number } | null) {
  await requireProject(ctx, projectId, 'project.manage');
  if (printer) {
    const parsed = parsePrinterAddress(printer.host, printer.port);
    if ('error' in parsed) throw badRequest(parsed.error);
    printer = parsed;
  }
  await q(`update projects set receipt_printer_host = $2, receipt_printer_port = $3 where id = $1`, [projectId, printer?.host ?? null, printer?.port ?? null]);
  await audit(ctx, {
    action: 'project.receipt_printer', entityType: 'project', entityId: projectId, projectId,
    summary: printer ? `Set the receipt printer to ${printer.host}:${printer.port}` : 'Removed the receipt printer',
  });
  publish({ projectId, type: 'project.updated', actor: ctx.user.name });
  return { ok: true };
}

export async function printTestTicket(ctx: Ctx, projectId: string) {
  await requireProject(ctx, projectId, 'project.manage');
  const p = await projectPrinter(projectId);
  await sendToPrinter(p.host, p.port, buildTestTicket(p.name));
  return { ok: true };
}

/** Prints cards as tickets (one cut each), in the order given, in a single job. Reusable for "print me a task" later. */
export async function printCardTickets(ctx: Ctx, projectId: string, keys: string[]) {
  await requireProject(ctx, projectId, 'project.view');
  const p = await projectPrinter(projectId);
  const cards = await cardsForPrint(projectId, keys.slice(0, MAX_TICKETS));
  if (!cards.length) throw badRequest('No cards to print');
  let logo: Buffer | null = null;
  if (p.logo_key) {
    logo = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of await getObject(p.logo_key!)) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    })().catch(() => null);
  }
  logo ??= await defaultLogoPng().catch(() => null);
  const tickets = [];
  for (const c of cards) tickets.push(await buildTicket(c, `${config.publicUrl}/c/${c.link_token}`, logo));
  await sendToPrinter(p.host, p.port, Buffer.concat(tickets));
  const list = cards.length === 1 ? cards[0].key : `${cards.length} cards (${cards.slice(0, 5).map((c) => c.key).join(', ')}${cards.length > 5 ? ', ...' : ''})`;
  await audit(ctx, { action: 'card.printed', entityType: cards.length === 1 ? 'card' : 'project', entityId: cards.length === 1 ? cards[0].id : projectId, projectId, summary: `Printed ${list} on the receipt printer` });
  return { printed: cards.length };
}
