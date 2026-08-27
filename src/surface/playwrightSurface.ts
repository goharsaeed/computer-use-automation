import { chromium, type Browser, type Page, type Locator } from "playwright";
import type { Action } from "../types/schemas.js";
import path from "node:path";
import fs from "node:fs";

export type Observation = {
  url: string;
  title: string;
  textSnippet: string;
  hasMemberIdInput: boolean;
  hasLookupSubmit: boolean;
  hasSavingsBalance: boolean;
  hasErrorPanel: boolean;
  hasSessionNotice: boolean;
  errorCode?: string;
  errorMessage?: string;
  memberName?: string;
  savingsBalance?: string;
};

export type SurfaceSession = {
  browser: Browser;
  page: Page;
};

/** Contract for web/desktop computer-use surfaces (Phase 1.2). */
export interface SurfaceAdapter {
  launch(headless?: boolean): Promise<void>;
  close(): Promise<void>;
  observe(): Promise<Observation>;
  act(action: Action): Promise<{ ok: boolean; detail: string; extracted?: string }>;
  screenshot(filePath: string): Promise<string>;
  getSessionHandle(): SurfaceSession | unknown;
  pauseForHuman(): void;
  resumeAutomation(): void;
}

export class PlaywrightSurface implements SurfaceAdapter {
  private session: SurfaceSession | null = null;
  ownership: "automation" | "human" = "automation";

  async launch(headless = true): Promise<void> {
    const browser = await chromium.launch({ headless });
    const page = await browser.newPage();
    this.session = { browser, page };
    this.ownership = "automation";
  }

  getPage(): Page {
    if (!this.session) throw new Error("Surface session not started");
    return this.session.page;
  }

  getSessionHandle(): SurfaceSession {
    if (!this.session) throw new Error("Surface session not started");
    return this.session;
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.browser.close();
      this.session = null;
    }
  }

  async observe(): Promise<Observation> {
    const page = this.getPage();
    const url = page.url();
    const title = await page.title();
    const bodyText = (await page.locator("body").innerText()).slice(0, 2000);

    const hasMemberIdInput = (await page.locator("#memberId").count()) > 0;
    const hasLookupSubmit = (await page.locator("#lookup-submit").count()) > 0;
    const hasSavingsBalance = (await page.locator("#savings-balance").count()) > 0;
    const hasErrorPanel = (await page.locator("#error-panel").count()) > 0;
    const notice = page.locator("#session-notice:not([hidden])");
    const hasSessionNotice =
      (await notice.count()) > 0 && (await notice.first().isVisible().catch(() => false));

    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    if (hasErrorPanel) {
      errorCode = (await page.locator("#error-panel").getAttribute("data-error-code")) || undefined;
      errorMessage = await page.locator("#error-message").innerText();
    }

    let memberName: string | undefined;
    let savingsBalance: string | undefined;
    if (hasSavingsBalance) {
      memberName = await page.locator("#member-name").innerText();
      savingsBalance = await page.locator("#savings-balance").innerText();
    }

    return {
      url,
      title,
      textSnippet: bodyText,
      hasMemberIdInput,
      hasLookupSubmit,
      hasSavingsBalance,
      hasErrorPanel,
      hasSessionNotice,
      errorCode,
      errorMessage,
      memberName,
      savingsBalance,
    };
  }

  private resolveLocator(strategy: string, value: string): Locator {
    const page = this.getPage();
    switch (strategy) {
      case "testid":
        return page.getByTestId(value);
      case "label":
        return page.getByLabel(value);
      case "role": {
        // value format: role=name e.g. button=Search
        const [role, name] = value.split("=");
        return page.getByRole(role as "button", { name });
      }
      case "text":
        return page.getByText(value, { exact: false });
      case "css":
      default:
        return page.locator(value);
    }
  }

  async act(action: Action): Promise<{ ok: boolean; detail: string; extracted?: string }> {
    if (this.ownership !== "automation") {
      return { ok: false, detail: "Automation paused; human owns the session." };
    }
    const page = this.getPage();

    switch (action.type) {
      case "navigate": {
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        return { ok: true, detail: `Navigated to ${action.url}` };
      }
      case "click": {
        const loc = this.resolveLocator(action.locator.strategy, action.locator.value);
        try {
          await loc.first().click({ timeout: 10000 });
          await page.waitForLoadState("domcontentloaded");
          return { ok: true, detail: `Clicked ${action.locator.strategy}:${action.locator.value}` };
        } catch (err) {
          return {
            ok: false,
            detail: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "type": {
        const loc = this.resolveLocator(action.locator.strategy, action.locator.value);
        try {
          if (action.clear !== false) await loc.first().fill("");
          await loc.first().fill(action.text);
          return { ok: true, detail: `Typed into ${action.locator.value}` };
        } catch (err) {
          return {
            ok: false,
            detail: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "extract": {
        const loc = this.resolveLocator(action.locator.strategy, action.locator.value);
        try {
          const text = (await loc.first().innerText({ timeout: 5000 })).trim();
          return { ok: true, detail: `Extracted ${action.name}`, extracted: text };
        } catch (err) {
          return {
            ok: false,
            detail: `Extract failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "done":
        return { ok: true, detail: "Done" };
      case "escalate":
        return { ok: true, detail: `Escalate: ${action.reason}` };
      default:
        return { ok: false, detail: "Unknown action" };
    }
  }

  async screenshot(filePath: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await this.getPage().screenshot({ path: filePath, fullPage: true });
    return filePath;
  }

  pauseForHuman(): void {
    this.ownership = "human";
  }

  resumeAutomation(): void {
    this.ownership = "automation";
  }
}
