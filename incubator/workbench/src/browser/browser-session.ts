import {
  startBrowserHost,
  type BrowserControlHandler,
  type BrowserApplication,
} from "./browser-host.js";
import {
  launchOwnedBrowser,
  type OwnedBrowserOptions,
} from "./owned-browser.js";

export interface BrowserSessionOptions extends OwnedBrowserOptions {
  application: BrowserApplication;
  onControl?: BrowserControlHandler;
}

/** Existing owned verification mode: a fresh host, run and Chromium per session. */
export async function startBrowserSession(
  baseUrl: string,
  options: BrowserSessionOptions,
) {
  const host = await startBrowserHost(baseUrl, options);
  let browser: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      options.signal.removeEventListener("abort", stop);
      try {
        await browser?.close();
      } finally {
        await host.close();
      }
    })());

  const stop = () => {
    void close().catch(() => {});
  };

  try {
    browser = await launchOwnedBrowser(host.pageUrl, {
      ...options,
      signal: options.signal,
    });
    const signal = AbortSignal.any([browser.signal, host.signal]);
    signal.addEventListener(
      "abort",
      () => {
        if (
          !options.keepOpenOnFailure ||
          browser?.page.isClosed() ||
          options.signal.aborted
        )
          void close().catch(() => {});
      },
      { once: true },
    );
    // Caller cancellation must close a page retained after a failed run.
    options.signal.addEventListener("abort", stop, { once: true });
    browser.page.once("close", stop);
    await host.waitForReady(signal);
    return {
      host,
      page: browser.page,
      signal,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
