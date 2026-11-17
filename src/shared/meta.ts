// Shared by the worker and the dashboard: the URL parameters every Meta ad gets (docs/GUIDE.md, "Meta ads").
//
// ad_id carries the ad's id, which the Ads view joins on: ids stay the same when an ad is renamed, while Meta fills the
// name macros with the name the ad had when it was first published. The utm_* values keep the generic panels readable:
// utm_source is fb, ig, msg or an (Facebook, Instagram, Messenger, Audience Network), utm_term the placement.
export const META_URL_PARAMETERS =
  'utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{placement}}&ad_id={{ad.id}}';

/** The Conversions API modes a site can pick. */
export const META_CAPI_MODES = ['off', 'clicks', 'all'] as const;

/** Meta's standard events a goal can be sent as. */
export const META_STANDARD_EVENTS = ['Lead', 'InitiateCheckout', 'AddToCart', 'AddPaymentInfo', 'CompleteRegistration', 'ViewContent', 'Contact', 'Subscribe', 'StartTrial', 'Search'] as const;
