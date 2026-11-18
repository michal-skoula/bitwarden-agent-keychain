// Fills credentials into the shared browser through the Playwright API.
//
// The keychain and Playwright MCP attach to the same Chromium over CDP. The
// agent drives navigation through Playwright MCP; this module types secrets
// into the page directly, so they never pass through the agent's context.
//
// A filled password sits in the DOM, and Playwright MCP's browser_snapshot
// prints input values in cleartext. So every fill is followed by a submit, and
// if the form is still on screen after that, the field gets cleared.

import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright-core';
import { anyUriMatches, baseDomain } from './origin.ts';
import type { LoginUri } from './bitwarden.ts';

export class FillError extends Error {}

export interface FillOptions {
  pageUrl?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface TotpOptions {
  pageUrl?: string;
  totpSelector?: string;
  submitSelector?: string;
}

export interface FillResult {
  filled: string[];
  submitted: 'clicked' | 'enter';
  outcome: 'navigated' | 'form_gone' | 'form_still_present_cleared' | 'no_secret_filled';
  url: string;
  // The frame the secret was typed into. With the page URL after submit, these
  // are the origins that get wiped later.
  frameUrl: string;
}

export class BrowserFiller {
  private readonly cdpEndpoint: string;
  private readonly settleMs: number;
  private browser: Promise<Browser> | null = null;

  constructor(cdpEndpoint: string, settleMs = 10_000) {
    this.cdpEndpoint = cdpEndpoint;
    this.settleMs = settleMs;
  }

  private connect(): Promise<Browser> {
    if (!this.browser) {
      const p = chromium.connectOverCDP(this.cdpEndpoint).then((b) => {
        b.on('disconnected', () => {
          this.browser = null;
        });
        return b;
      });
      p.catch(() => {
        this.browser = null;
      });
      this.browser = p;
    }
    return this.browser.catch((e) => {
      throw new FillError(`Cannot reach the browser at ${this.cdpEndpoint}: ${(e as Error).message.split('\n')[0]}`);
    });
  }

  async openUrls(): Promise<string[]> {
    const b = await this.connect();
    return b.contexts().flatMap((c) => c.pages().map((p) => p.url()));
  }

  // Picks the tab to fill. Only tabs whose URL (or one of whose frames' URLs)
  // matches the vault item's saved URIs qualify.
  private async pickPage(uris: LoginUri[], pageUrl?: string): Promise<Page> {
    const b = await this.connect();
    let pages = b.contexts().flatMap((c) => c.pages());
    if (pageUrl) pages = pages.filter((p) => p.url().startsWith(pageUrl));
    const matching = pages.filter((p) => p.frames().some((f) => anyUriMatches(f.url(), uris)));
    if (matching.length === 0) {
      const open = (await this.openUrls()).map((u) => `  - ${u}`).join('\n') || '  (none)';
      const saved = uris.map((u) => `  - ${u.uri}`).join('\n') || '  (item has no URIs saved)';
      throw new FillError(
        `No open tab matches this login's saved URIs, so nothing was filled.\nSaved URIs:\n${saved}\nOpen tabs:\n${open}`,
      );
    }
    // Several matching tabs: the most recently opened one is the best guess.
    return matching[matching.length - 1];
  }

  private matchingFrames(page: Page, uris: LoginUri[]): Frame[] {
    return page.frames().filter((f) => anyUriMatches(f.url(), uris));
  }

  async fillLogin(
    uris: LoginUri[],
    creds: { username: string | null; password: string | null },
    opts: FillOptions,
  ): Promise<FillResult> {
    const page = await this.pickPage(uris, opts.pageUrl);
    const frames = this.matchingFrames(page, uris);

    let username: Locator | null = null;
    let password: Locator | null = null;
    let frameUrl = page.url();
    for (const frame of frames) {
      const found = await locateLoginFields(frame, opts);
      if (found.username || found.password) {
        ({ username, password } = found);
        frameUrl = frame.url();
        break;
      }
    }
    if (!username && !password) {
      throw new FillError(
        'No username or password field found on the page. Pass username_selector and/or password_selector ' +
          '(CSS like "#email" or Playwright selectors like \'role=textbox[name="Email"]\').',
      );
    }

    const filled: string[] = [];
    if (username && creds.username) {
      await username.fill(creds.username);
      filled.push('username');
    }
    if (password && creds.password) {
      await password.fill(creds.password);
      filled.push('password');
    }
    if (filled.length === 0) throw new FillError('The vault item has no username or password to fill into the fields found.');

    const lastField = password && creds.password ? password : (username as Locator);
    const r = await this.submitAndSettle(page, lastField, filled, password && creds.password ? password : null, opts.submitSelector);
    return { ...r, frameUrl };
  }

  async fillTotp(uris: LoginUri[], code: string, opts: TotpOptions): Promise<FillResult> {
    const page = await this.pickPage(uris, opts.pageUrl);
    let field: { locator: Locator; split: boolean } | null = null;
    let frameUrl = page.url();
    for (const frame of this.matchingFrames(page, uris)) {
      field = await locateTotpField(frame, opts.totpSelector);
      if (field) {
        frameUrl = frame.url();
        break;
      }
    }
    if (!field) {
      throw new FillError('No one-time code field found on the page. Pass totp_selector.');
    }
    if (field.split) {
      // Six single-digit boxes: type into the first and let the page advance focus.
      await field.locator.click();
      await page.keyboard.type(code, { delay: 30 });
    } else {
      await field.locator.fill(code);
    }
    const r = await this.submitAndSettle(page, field.locator, ['totp'], field.split ? null : field.locator, opts.submitSelector);
    return { ...r, frameUrl };
  }

  // Removes the browser's copy of a login session: all storage for the origin
  // (localStorage, IndexedDB, cache, service workers, its cookies), plus every
  // cookie on its registrable domain, which catches ".example.com" cookies set
  // from another subdomain.
  async wipeOrigin(origin: string): Promise<void> {
    const b = await this.connect();
    // Storage.* fails with "Internal error" on the browser target, so go
    // through a page. Storage is per profile, so any tab works. Borrowing an
    // open one keeps a new tab from popping up in the agent's tab list.
    for (const context of b.contexts()) {
      const borrowed = context.pages()[0];
      const page = borrowed ?? (await context.newPage());
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
        await cdp.detach().catch(() => {});
      } finally {
        if (!borrowed) await page.close().catch(() => {});
      }
    }
    const base = baseDomain(new URL(origin).hostname);
    const escaped = base.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const domain = new RegExp(`(^|\\.)${escaped}$`, 'i');
    for (const context of b.contexts()) await context.clearCookies({ domain });
  }

  private async submitAndSettle(
    page: Page,
    lastField: Locator,
    filled: string[],
    secretField: Locator | null,
    submitSelector?: string,
  ): Promise<Omit<FillResult, 'frameUrl'>> {
    const startUrl = page.url();
    const secretHandle = secretField ? await secretField.elementHandle() : null;

    let submitted: FillResult['submitted'];
    const button = submitSelector ? page.locator(submitSelector).first() : await findSubmitButton(lastField);
    if (button) {
      await button.click({ timeout: 5_000 });
      submitted = 'clicked';
    } else {
      await lastField.press('Enter');
      submitted = 'enter';
    }

    if (!secretHandle) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return { filled, submitted, outcome: 'no_secret_filled', url: page.url() };
    }

    // Wait for the secret to leave the page: navigation, the field being removed
    // or hidden, or the page clearing it itself.
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      if (page.url() !== startUrl) return { filled, submitted, outcome: 'navigated', url: page.url() };
      let present: boolean;
      try {
        present = await secretHandle.evaluate(
          (el) => el.isConnected && (el as HTMLInputElement).value !== '' && el.getClientRects().length > 0,
        );
      } catch {
        // Execution context destroyed: the page navigated.
        return { filled, submitted, outcome: 'navigated', url: page.url() };
      }
      if (!present) return { filled, submitted, outcome: 'form_gone', url: page.url() };
      await page.waitForTimeout(250);
    }

    // Still there. Most likely a failed login or a captcha. Wipe it so a
    // snapshot can't read it.
    try {
      await secretHandle.evaluate((el) => {
        const input = el as HTMLInputElement;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch {
      return { filled, submitted, outcome: 'navigated', url: page.url() };
    }
    return { filled, submitted, outcome: 'form_still_present_cleared', url: page.url() };
  }
}

// ---------------------------------------------------------------------------
// Field detection. Runs inside the page, from the keychain's own Playwright
// connection, so the agent never sees what happens here.

interface DetectedIndices {
  username: number;
  password: number;
}

async function locateLoginFields(
  frame: Frame,
  opts: FillOptions,
): Promise<{ username: Locator | null; password: Locator | null }> {
  const pick = async (sel: string | undefined) => {
    if (!sel) return null;
    const loc = frame.locator(sel).first();
    return (await loc.count()) > 0 ? loc : null;
  };
  if (opts.usernameSelector || opts.passwordSelector) {
    return { username: await pick(opts.usernameSelector), password: await pick(opts.passwordSelector) };
  }

  const inputs = frame.locator('input');
  const idx: DetectedIndices = await inputs.evaluateAll((els) => {
    const list = els as HTMLInputElement[];
    const usable = (el: HTMLInputElement) =>
      !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const label = (el: HTMLInputElement) =>
      [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? '', el.autocomplete].join(' ');

    const passwords = list.map((el, i) => ({ el, i })).filter(({ el }) => el.type === 'password' && usable(el));
    const current =
      passwords.find(({ el }) => el.autocomplete === 'current-password') ??
      passwords.find(({ el }) => el.autocomplete !== 'new-password') ??
      passwords[0];
    const pw = current ? current.i : -1;

    const textTypes = new Set(['text', 'email', 'tel', '']);
    let best = -1;
    let bestScore = -Infinity;
    list.forEach((el, i) => {
      if (!textTypes.has(el.type) || !usable(el)) return;
      if (pw >= 0 && i >= pw) return; // username fields come before the password
      const l = label(el);
      if (/search|query|coupon|promo/i.test(l)) return;
      let score = 0;
      if (el.autocomplete === 'username') score += 10;
      if (el.type === 'email' || el.autocomplete === 'email') score += 5;
      if (/user|login|e-?mail|account|identifier|handle/i.test(l)) score += 4;
      if (pw >= 0) {
        if (list[pw].form && el.form === list[pw].form) score += 3;
        score += i / 1000; // closer to the password field wins ties
      }
      if (pw < 0 && score <= 0) return; // without a password field, require some signal
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return { username: best, password: pw };
  });

  return {
    username: idx.username >= 0 ? inputs.nth(idx.username) : null,
    password: idx.password >= 0 ? inputs.nth(idx.password) : null,
  };
}

async function locateTotpField(frame: Frame, selector?: string): Promise<{ locator: Locator; split: boolean } | null> {
  if (selector) {
    const loc = frame.locator(selector).first();
    return (await loc.count()) > 0 ? { locator: loc, split: false } : null;
  }
  const inputs = frame.locator('input');
  const found: { index: number; split: boolean } = await inputs.evaluateAll((els) => {
    const list = els as HTMLInputElement[];
    const usable = (el: HTMLInputElement) =>
      !el.disabled && !el.readOnly && el.getClientRects().length > 0 && ['text', 'tel', 'number', ''].includes(el.type);

    const singles = list.map((el, i) => ({ el, i })).filter(({ el }) => usable(el) && el.maxLength === 1);
    if (singles.length >= 4) return { index: singles[0].i, split: true };

    let best = -1;
    let bestScore = 0;
    list.forEach((el, i) => {
      if (!usable(el)) return;
      const l = [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? ''].join(' ');
      let score = 0;
      if (el.autocomplete === 'one-time-code') score += 10;
      if (/otp|totp|2fa|mfa|one.?time|verif|auth.?code|security.?code|\bcode\b|token|pin/i.test(l)) score += 5;
      if (el.inputMode === 'numeric' || el.type === 'tel' || el.type === 'number') score += 2;
      if (el.maxLength >= 6 && el.maxLength <= 8) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return { index: bestScore >= 4 ? best : -1, split: false };
  });
  return found.index >= 0 ? { locator: inputs.nth(found.index), split: found.split } : null;
}

async function findSubmitButton(field: Locator): Promise<Locator | null> {
  const form = field.locator('xpath=ancestor::form[1]');
  if ((await form.count()) === 0) return null;
  const button = form
    .locator('button[type=submit], input[type=submit], button:not([type])')
    .filter({ visible: true })
    .first();
  return (await button.count()) > 0 ? button : null;
}
