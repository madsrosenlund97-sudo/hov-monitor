// CommonJS-port af houseofvinterberg-frontend/src/lib/tracking/channel.ts.
// VIGTIGT: hvis logikken ændres her, opdater frontend-versionen tilsvarende
// (og omvendt) - de skal være 1:1 så admin-panel og Telegram-notifikation
// klassificerer samme touch til samme kanal.

const META_SOURCES = new Set(['facebook', 'instagram', 'meta', 'fb', 'ig']);
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid_social', 'paidsocial']);
const SOCIAL_DOMAINS = [
  'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
  'pinterest.com', 'snapchat.com', 't.co', 'lm.facebook.com', 'l.instagram.com',
];
const SOCIAL_SOURCES = new Set(['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'snapchat']);
const SEARCH_ENGINE_DOMAINS = ['google.', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'yahoo.com'];
const OWN_DOMAINS = ['houseofvinterberg.com', 'vercel.app'];

function lower(v) {
  return (v == null ? '' : String(v)).toLowerCase();
}

function referrerHost(ref) {
  if (!ref) return '';
  try {
    return new URL(ref).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function matchesAny(host, suffixes) {
  if (!host) return false;
  return suffixes.some((s) => host.includes(s));
}

function classifyChannel(touch) {
  if (!touch) return 'other';
  const source = lower(touch.utm_source);
  const medium = lower(touch.utm_medium);
  const clickType = lower(touch.click_id_type);
  const host = referrerHost(touch.referrer);

  // Regel 1: Google paid
  if (clickType === 'gclid') return 'google';
  if (source === 'google' && PAID_MEDIUMS.has(medium)) return 'google';

  // Regel 2: Meta paid
  if (clickType === 'fbclid') return 'meta';
  if (META_SOURCES.has(source) && PAID_MEDIUMS.has(medium)) return 'meta';

  // Regel 3: Social organic
  if (SOCIAL_SOURCES.has(source) && !PAID_MEDIUMS.has(medium)) return 'some_organic';
  if (matchesAny(host, SOCIAL_DOMAINS)) return 'some_organic';

  // Regel 4: Organic
  const hasUtm = Boolean(source || medium || touch.utm_campaign);
  const hasClickId = Boolean(touch.click_id);
  if (!hasUtm && !hasClickId) {
    if (!host) return 'organic';
    if (matchesAny(host, OWN_DOMAINS)) return 'organic';
    if (matchesAny(host, SEARCH_ENGINE_DOMAINS)) return 'organic';
  }
  if (source === 'direct') return 'organic';

  // Regel 5: Andet
  return 'other';
}

const CHANNEL_LABEL = {
  organic: 'Organisk',
  google: 'Google',
  meta: 'Meta',
  some_organic: 'SoMe organisk',
  other: 'Andet',
};

module.exports = { classifyChannel, CHANNEL_LABEL };
