"use client";

import { useCallback, useState } from "react";
import { usePreferences } from "@/components/preferences-provider";
import { Button } from "@/components/ui/button";

export function DesktopLogin({
  state,
  challenge,
  identity,
  valid,
}: {
  state: string;
  challenge: string;
  identity: string;
  valid: boolean;
}) {
  const { t } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [callback, setCallback] = useState("");
  const [error, setError] = useState(false);
  const connect = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth/desktop/authorize`,
        {
          body: JSON.stringify({ challenge, state }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      if (!response.ok) {
        throw new Error("Authorization failed");
      }
      const data = await response.json();
      const url = new URL(data.callback);
      if (
        url.protocol !== "piwork:" ||
        url.host !== "auth" ||
        url.pathname !== "/callback"
      ) {
        throw new Error("Invalid callback");
      }
      setCallback(url.href);
      window.location.assign(url.href);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [challenge, state]);
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">
        {t(callback ? "desktopLogin.readyTitle" : "desktopLogin.title")}
      </h1>
      <p className="text-base text-muted-foreground">
        {t(
          valid
            ? callback
              ? "desktopLogin.readyDescription"
              : "desktopLogin.description"
            : "desktopLogin.invalid"
        )}
      </p>
      {valid ? (
        <>
          <p className="break-all py-3 font-medium">{identity}</p>
          {callback ? (
            <Button asChild>
              <a href={callback}>{t("desktopLogin.openClient")}</a>
            </Button>
          ) : null}
          <Button
            disabled={busy}
            onClick={connect}
            variant={callback ? "outline" : "default"}
          >
            {t(
              busy
                ? "desktopLogin.connecting"
                : callback
                  ? "desktopLogin.retry"
                  : "desktopLogin.authorize"
            )}
          </Button>
        </>
      ) : null}
      {error ? (
        <p className="text-destructive" role="alert">
          {t("desktopLogin.error")}
        </p>
      ) : null}
    </>
  );
}
