import {
  getCookie,
  isEmbedPageUrl,
  isWatchPageUrl,
  on,
  requestIdleCallback,
  wrapErrorHandler,
} from './generic';
import { injectedScript } from './messaging/injected';
import SentryReporter from './sentry-reporter';
import { storage } from './storage';

const THEME_LIGHT = -1;
const THEME_DEFAULT = 0;
const THEME_DARK = 1;

export default class Theming {
  constructor(ambientlight) {
    this.ambientlight = ambientlight;
    this.settings = ambientlight.settings;
  }

  initListeners() {
    // Appearance (theme) changes initiated by the YouTube menu
    this.youtubeTheme = this.isDarkTheme() ? 1 : -1;
    on(
      document,
      'yt-action',
      async (e) => {
        if (!this.settings.enabled) return;
        const name = e?.detail?.actionName;
        if (name === 'yt-signal-action-toggle-dark-theme-off') {
          this.youtubeTheme = await this.prefCookieToTheme();
          this.updateTheme();
        } else if (name === 'yt-signal-action-toggle-dark-theme-on') {
          this.youtubeTheme = await this.prefCookieToTheme();
          this.updateTheme();
        } else if (name === 'yt-signal-action-toggle-dark-theme-device') {
          this.youtubeTheme = await this.prefCookieToTheme();
          this.updateTheme();
        } else if (name === 'yt-forward-redux-action-to-live-chat-iframe') {
          // Let YouTube change the theme to an incorrect color in this process
          requestIdleCallback(
            function forwardReduxActionToLiveChatIframe() {
              // Fix the theme to the correct color after the process
              if (!this.ambientlight.isOnVideoPage) return;
              if (e.detail.args?.[0]?.type === 'SET_WATCH_SCROLL_TOP') return;

              this.updateLiveChatTheme();
            }.bind(this),
            { timeout: 1 }
          );
        }
      },
      undefined,
      true
    );

    try {
      // Firefox does not support the cookieStore
      if (window.cookieStore?.addEventListener) {
        cookieStore.addEventListener(
          'change',
          wrapErrorHandler(async (e) => {
            for (const change of e.changed) {
              if (change.name !== 'PREF') continue;

              this.youtubeTheme = await this.prefCookieToTheme(change.value);
              this.updateTheme();
            }
          }, true)
        );
      }
      matchMedia('(prefers-color-scheme: dark)').addEventListener(
        'change',
        wrapErrorHandler(async () => {
          this.youtubeTheme = await this.prefCookieToTheme();
          this.updateTheme();
        }, true)
      );
    } catch (ex) {
      SentryReporter.captureException(ex);
    }

    let themeCorrections = 0;
    this.themeObserver = new MutationObserver(
      wrapErrorHandler(() => {
        if (!this.shouldToggleTheme()) return;

        themeCorrections++;
        this.updateTheme();
        if (themeCorrections === 5) this.themeObserver.disconnect();
      })
    );
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['dark'],
    });

    if (isEmbedPageUrl()) return;

    this.initLiveChat(); // Depends on this.youtubeTheme set in initListeners
  }

  prefCookieToTheme = async (cookieValue) => {
    if (!cookieValue) {
      cookieValue = (await getCookie('PREF'))?.value || '';
    }

    let f6 = new URLSearchParams(cookieValue)?.get('f6') || null;
    if (f6 != null && /^[A-Fa-f0-9]+$/.test(f6)) {
      f6 = parseInt(f6, 16);
    }
    f6 = f6 || 0;

    if (f6 & (1 << 165 % 31)) return THEME_DARK;
    if (f6 & (1 << 174 % 31)) return THEME_LIGHT;
    if (matchMedia('(prefers-color-scheme: dark)').matches) return THEME_DARK;
    return THEME_LIGHT;
  };

  isDarkTheme = () => document.documentElement.getAttribute('dark') != null;

  shouldBeDarkTheme = (enabledAndVisible) => {
    const enabled =
      enabledAndVisible === undefined
        ? !this.settings.enabled || this.ambientlight.isHidden
        : !enabledAndVisible;
    const toTheme =
      enabled || this.settings.theme === THEME_DEFAULT
        ? this.youtubeTheme
        : this.settings.theme;
    return toTheme === THEME_DARK;
  };

  shouldToggleTheme = () => {
    const toDark = this.shouldBeDarkTheme();
    return !(this.isDarkTheme() === toDark || (toDark && !isWatchPageUrl()));
  };

  updateTheme = wrapErrorHandler(
    async function updateTheme(fromSettings = false) {
      if (
        this.updatingTheme ||
        (!fromSettings && this.settings.theme === THEME_DEFAULT) ||
        !this.shouldToggleTheme()
      )
        return;

      this.updatingTheme = true;

      if (this.themeToggleFailed !== false) {
        const lastFailedThemeToggle = await new Promise(
          // eslint-disable-next-line no-async-promise-executor
          async (resolve, reject) => {
            try {
              let timeout = setTimeout(() => {
                timeout = undefined;
                resolve();
              }, 5000);
              const result = await storage.get('last-failed-theme-toggle');
              if (!timeout) return;

              clearTimeout(timeout);
              resolve(result);
            } catch (ex) {
              reject(ex);
            }
          }
        );

        if (lastFailedThemeToggle) {
          const now = new Date().getTime();
          const withinThresshold = now - 10000 < lastFailedThemeToggle;
          if (withinThresshold) {
            this.settings.setWarning(
              `Because the previous attempt failed and to prevent repeated page refreshes we temporarily disabled the automatic toggle to the ${
                this.isDarkTheme() ? 'light' : 'dark'
              } appearance for 10 seconds.\n\nSet the "Appearance (theme)" setting to "Default" to disable the automatic appearance toggle permanently if it keeps on failing.\n(And let me know via the feedback form that it failed so that I can fix it in the next version of the extension)`
            );
            this.updatingTheme = false;
            return;
          }
          storage.set('last-failed-theme-toggle', undefined);
        }
        if (this.themeToggleFailed) {
          this.settings.setWarning('');
          this.themeToggleFailed = false;
        }

        if (!this.shouldToggleTheme()) {
          this.updatingTheme = false;
          return;
        }
      }

      await this.toggleDarkTheme();
      this.updatingTheme = false;
    }.bind(this),
    true
  );

  async updateDocumentTheme(toDark) {
    const start = performance.now();

    await injectedScript.postAndReceiveMessage('update-theme', toDark);

    performance.measure('updateDocumentTheme', {
      start,
      end: performance.now(),
    });
  }

  async toggleDarkTheme() {
    const wasDark = this.isDarkTheme();
    await this.updateDocumentTheme(!wasDark);
    if (!isEmbedPageUrl()) {
      this.updateLiveChatTheme();
    }

    const isDark = this.isDarkTheme();
    if (wasDark !== isDark) return;

    this.themeToggleFailed = true;
    await storage.set('last-failed-theme-toggle', new Date().getTime());
    this.settings.setWarning(
      `Failed to toggle the page theme to from ${
        wasDark ? 'dark' : 'light'
      } to ${
        isDark ? 'dark' : 'light'
      } mode.\n\nSet the "Appearance (theme)" setting to "Default" to disable the automatic appearance toggle permanently if it keeps on failing.\n(And let me know via the feedback form that it failed so that I can fix it in the next version of the extension)`
    );
  }

  initLiveChat = () => {
    this.initLiveChatSecondaryElem();
    if (this.secondaryElem) return;

    const observer = new MutationObserver(
      wrapErrorHandler(() => {
        this.initLiveChatSecondaryElem();
        if (!this.secondaryElem) return;

        observer.disconnect();
      })
    );
    observer.observe(this.ambientlight.ytdAppElem, {
      childList: true,
      subtree: true,
    });
  };

  initLiveChatSecondaryElem = () => {
    this.secondaryElem = document.querySelector('#secondary');
    if (!this.secondaryElem) return;

    this.initLiveChatElem();
    const observer = new MutationObserver(
      wrapErrorHandler(this.initLiveChatElem)
    );
    observer.observe(this.secondaryElem, {
      childList: true,
    });
  };

  initLiveChatElem = () => {
    const liveChatElem = document.querySelector('ytd-app ytd-live-chat-frame');
    if (!liveChatElem || this.liveChatElem === liveChatElem) return;

    liveChatElem.dataset.ytalElem = 'live-chat';
    this.liveChatElem = liveChatElem;

    this.initLiveChatIframe();
    const observer = new MutationObserver(
      wrapErrorHandler(this.initLiveChatIframe)
    );
    observer.observe(liveChatElem, {
      childList: true,
    });
  };

  initLiveChatIframe = () => {
    const iframeElem = document.querySelector(
      'ytd-app ytd-live-chat-frame iframe'
    );
    if (!iframeElem || this.liveChatIframeElem === iframeElem) return;

    this.liveChatIframeElem = iframeElem;
    this.updateLiveChatTheme();
    iframeElem.addEventListener('load', () => {
      this.ambientlight.updateLayoutPerformanceImprovements();
      this.updateLiveChatTheme();
    });
  };

  updateLiveChatThemeThrottle = {};
  updateLiveChatTheme = () => {
    if (!this.liveChatElem || !this.liveChatIframeElem) this.initLiveChatElem();
    if (!this.liveChatElem || !this.liveChatIframeElem) return;
    if (this.updateLiveChatThemeThrottle.timeout) return;

    const update = function updateLiveChatThemeUpdate() {
      this.updateLiveChatThemeThrottle.updateTime = performance.now();
      if (!this.ambientlight.isOnVideoPage) return;

      const toDark = this.shouldBeDarkTheme();
      injectedScript.postMessage('set-live-chat-theme', toDark);
    }.bind(this);

    if (this.updateLiveChatThemeThrottle.updateTime > performance.now() - 500) {
      this.updateLiveChatThemeThrottle.timeout = setTimeout(() => {
        update();
        this.updateLiveChatThemeThrottle.timeout = undefined;
      }, 500);
    } else {
      update();
    }
  };
}
