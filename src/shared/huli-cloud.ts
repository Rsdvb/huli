// Huli's own clients of Huli Cloud beside Kettu's: the phone app, which signs in through the
// system browser with PKCE and comes back on the app's URL scheme (RFC 8252 7.1).

/** The phone app's OAuth client. */
export const MOBILE_CLIENT = 'huli-mobile'

/** Where the sign-in page sends the phone's browser back with the code. */
export const MOBILE_REDIRECT = 'huli://signin'

/** The path the hosted web client takes the sign-in's code back on, as CALLBACK_PATH. */
export const WEB_CALLBACK_PATH = '/signin/callback'
