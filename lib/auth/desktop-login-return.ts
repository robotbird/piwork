export const desktopSecretPattern = /^[A-Za-z0-9_-]{43}$/;

/** Restrict post-login navigation to the desktop authorization page. */
export function desktopLoginReturn(value: string | null): string | null {
  if (!value?.startsWith("/desktop-login?")) {
    return null;
  }
  const url = new URL(value, "https://piwork.invalid");
  if (url.pathname !== "/desktop-login" || url.hash) {
    return null;
  }
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("challenge");
  if (
    !state ||
    !challenge ||
    !desktopSecretPattern.test(state) ||
    !desktopSecretPattern.test(challenge)
  ) {
    return null;
  }
  return `/desktop-login?${new URLSearchParams({ challenge, state })}`;
}
