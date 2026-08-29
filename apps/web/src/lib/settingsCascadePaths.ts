// The settings shell gives cascade pages a full-bleed container: they own
// their own padding and scrolling because the rail must reach the viewport
// edges. Everything else gets the padded settings-content wrapper.
//
// Deliberately NOT a startsWith for model-providers: /settings/model-providers
// and its dashboard are cascade, but the managed/* sub-pages under it are
// ordinary settings pages and would look broken in a full-bleed shell.
export const isCascadePath = (pathname: string): boolean =>
    pathname.startsWith('/settings/runtimes') ||
    pathname.startsWith('/settings/channels') ||
    pathname.startsWith('/settings/api-tokens') ||
    pathname === '/settings/model-providers' ||
    pathname === '/settings/model-providers/dashboard'
