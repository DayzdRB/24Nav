/* ==========================================================================
   24Nav configuration

   Put your Universal Relay address here once and every visitor connects
   automatically. A bare host is fine; the scheme and the /v1/live path are added
   for you, and a pasted /v1/live is stripped.

       relayUrl: 'atc24-universal-relay.onrender.com'

   Leave it empty and nothing connects until an address is typed into the Live
   tab. Anything entered there is saved in that browser and overrides this file,
   so use "Use built-in address" on the Live tab to go back to whatever is set
   here.

   This file is public, like every other file the browser downloads. That is fine:
   the relay only carries public ATC24 data and is protected by ALLOWED_ORIGINS on
   Render, not by keeping the hostname secret. Never put a Supabase secret or any
   other credential in here.
   ========================================================================== */

window.NAV_CONFIG = {
  // Change this every time you upload. The Live tab and relay-check both print
  // it, so you can tell at a glance whether the site is serving your new files
  // or a cached copy of the old ones.
  buildTag: 'step3',

  relayUrl: '',

  // Which ATC24 server to track against. 'auto' checks the main server and then
  // the event server, which is what you want almost always.
  trackServer: 'auto',
};
