export const APP_URL = 'https://scottygo-ningrui.onrender.com/';

type NavigationRequest = {
  url: string;
  isTopFrame?: boolean;
  hasTargetFrame?: boolean;
  navigationType?: string;
};

function webURL(value: string): URL | null {
  if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function isAppURL(value: string): boolean {
  return webURL(value)?.origin === new URL(APP_URL).origin;
}

const mapFrameHosts = new Set([
  'www.google.com',
  'maps.google.com',
  'maps.googleapis.com',
  'maps.gstatic.com'
]);

export function navigationDecision(
  request: NavigationRequest
): 'allow' | 'openExternal' | 'cancel' {
  const isPopup = request.hasTargetFrame === false;
  const isEmbedded = request.isTopFrame === false && !isPopup;
  const isTap = request.navigationType === 'click';
  if (
    isEmbedded &&
    (request.url === 'about:blank' || request.url === 'about:srcdoc')
  ) {
    return 'allow';
  }

  const url = webURL(request.url);
  if (!url) return 'cancel';
  if (isAppURL(url.href)) return isPopup && !isTap ? 'cancel' : 'allow';
  if (isTap) return 'openExternal';
  if (
    isEmbedded &&
    url.protocol === 'https:' &&
    !url.port &&
    mapFrameHosts.has(url.hostname)
  ) {
    return 'allow';
  }
  return 'cancel';
}

// Fragments don't travel with HTTP requests. Compare the actual page URL
// so a failed map frame or resource cannot hide an otherwise usable page.
export function isPageHttpError(
  url: string,
  status: number,
  requestedPage: string
): boolean {
  const page = webURL(requestedPage);
  const failed = webURL(url);
  if (status < 400 || !page || !failed || !isAppURL(page.href)) return false;
  page.hash = '';
  failed.hash = '';
  return page.href === failed.href;
}
