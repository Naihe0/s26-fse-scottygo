/** Native colors around the hosted web app. The web header and the phone
 * section bar draw their own safe-area padding, so the WebView runs under the
 * status bar and home indicator. Keep these in step with the web tokens in
 * client/styles/shared.css (tests/host-chrome.test.mjs checks them). */
export const HEADER_COLOR = '#86142b'; // --app-brand-strong
export const CANVAS_COLOR = '#f5f5f7'; // --app-canvas

export type HostScreen = 'page' | 'error';

/** White text over the maroon header and loading screen; dark text over the
 * native error screen's white background. */
export function statusBarStyle(
  screen: HostScreen
): 'light-content' | 'dark-content' {
  return screen === 'error' ? 'dark-content' : 'light-content';
}
