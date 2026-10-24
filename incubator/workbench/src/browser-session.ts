import { chromium, type BrowserServer, type Browser } from "playwright";
import { startBrowserHost } from "./browser-host.js";

/** Own a fresh Chromium process/context and its local host, but not ZooGlass. */
export async function startBrowserSession(
  baseUrl: string,
  options: { signal: AbortSignal; headless?: boolean },
) {
  const host = await startBrowserHost(baseUrl);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    options.signal,
    host.signal,
    controller.signal,
  ]);
  let process: BrowserServer | undefined;
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      controller.abort(new Error("Browser session closed."));
      const force = setTimeout(() => {
        void process?.kill().catch(() => {});
      }, 5_000);
      try {
        await process?.close();
      } finally {
        clearTimeout(force);
        await host.close();
      }
    });
    return closing;
  };
  const stop = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    process = await chromium.launchServer({
      headless: options.headless ?? false,
      timeout: 15_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    // Cancellation during launch must close the newly acquired process too.
    if (signal.aborted) {
      await process.close();
      signal.throwIfAborted();
    }
    browser = await chromium.connect(process.wsEndpoint(), { timeout: 15_000 });
    browser.on("disconnected", () => {
      if (!closing) controller.abort(new Error("Owned browser exited."));
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("close", () => {
      if (!closing) controller.abort(new Error("Owned browser page closed."));
    });
    await page.goto(host.pageUrl, { timeout: 15_000 });
    await host.waitForReady(signal);
    return { host, page, signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
