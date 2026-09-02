/**
 * Shared-logging backend. THIS IS THE ONLY FILE YOU EDIT to turn sharing on.
 *
 * Leave both blank and the app is local-only: the sharing UI hides itself
 * entirely and nothing is ever sent anywhere. That is the shipped default.
 *
 * To enable it, create a free Supabase project, run supabase/schema.sql in its
 * SQL editor, then paste the project URL and the *anon* key below. See the
 * README section "Shared logging".
 *
 * The anon key is designed to be public — it is in every Supabase web app's
 * JavaScript. It is safe here BECAUSE schema.sql grants it insert-and-update
 * only, with no read access at all. Never put the service_role key in this
 * file; that one bypasses every policy and belongs only in .env on your own
 * machine.
 */
export const SHARE = {
  url: '',
  anonKey: '',

  /** Shown in the opt-in checkbox so people know where their reports land. */
  custodian: 'the project maintainer',
};

export const isShareConfigured = () => Boolean(SHARE.url && SHARE.anonKey);
