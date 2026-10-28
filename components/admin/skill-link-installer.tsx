"use client";

import { CheckCircle2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "@/components/preferences-provider";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { parseSkillInstallLink } from "@/lib/ai/skill-install-link";
import type {
  SkillInstallPreview,
  SkillInstallResult,
} from "@/lib/ai/skill-install-types";
import { SKILL_LIMIT_MB, SKILL_LIMITS } from "@/lib/ai/skill-limits";

export function SkillLinkInstaller({
  onBusyChange,
  onInstalled,
}: {
  onBusyChange: (busy: boolean) => void;
  onInstalled: () => Promise<void>;
}) {
  const { t } = usePreferences();
  const endpoint = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/admin/skills/install`;
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SkillInstallResult[]>([]);
  const [phase, setPhase] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const recognized = useMemo(() => parseSkillInstallLink(url), [url]);
  const eligible =
    preview?.candidates.filter((candidate) => !candidate.issue) ?? [];

  const discard = useCallback(() => {
    const token = tokenRef.current;
    tokenRef.current = null;
    if (token) {
      // Best effort only; bounded server TTL is the cleanup backstop.
      fetch(endpoint, {
        body: JSON.stringify({ token }),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "DELETE",
      }).catch(() => undefined);
    }
  }, [endpoint]);
  useEffect(() => discard, [discard]);

  const changeUrl = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      discard();
      setUrl(event.currentTarget.value);
      setPreview(null);
      setSelected(new Set());
      setResults([]);
      setError(null);
    },
    [discard]
  );

  const inspect = useCallback(async () => {
    if (!recognized || busy.current) {
      return;
    }
    discard();
    busy.current = true;
    setPhase("preview");
    onBusyChange(true);
    setError(null);
    setPreview(null);
    setResults([]);
    setSelected(new Set());
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ action: "preview", installUrl: url.trim() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("skills.installationFailed"));
      }
      const parsed = data as SkillInstallPreview;
      tokenRef.current = parsed.token;
      setPreview(parsed);
      // A single eligible skill is preselected; multi-skill repositories require an explicit choice.
      const candidates = parsed.candidates.filter(
        (candidate) => !candidate.issue
      );
      setSelected(new Set(candidates.length === 1 ? [candidates[0].id] : []));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("skills.installationFailed")
      );
    } finally {
      busy.current = false;
      setPhase(null);
      onBusyChange(false);
    }
  }, [discard, endpoint, onBusyChange, recognized, t, url]);

  const install = useCallback(async () => {
    if (!preview || !selected.size || busy.current) {
      return;
    }
    busy.current = true;
    setPhase("install");
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          action: "install",
          selectedIds: [...selected],
          token: preview.token,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          discard();
          setPreview(null);
          setSelected(new Set());
        }
        throw new Error(data.error || t("skills.installationFailed"));
      }
      const outcomes = data.results as SkillInstallResult[];
      setResults(outcomes);
      const completed = new Set(
        outcomes
          .filter(
            (result) =>
              result.status === "installed" || result.issue === "installed"
          )
          .map((result) => result.id)
      );
      setPreview((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((candidate) =>
                completed.has(candidate.id)
                  ? { ...candidate, issue: "installed" }
                  : candidate
              ),
            }
          : null
      );
      setSelected(new Set());
      if (outcomes.some((result) => result.status === "installed")) {
        await onInstalled();
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("skills.installationFailed")
      );
    } finally {
      busy.current = false;
      setPhase(null);
      onBusyChange(false);
    }
  }, [discard, endpoint, onBusyChange, onInstalled, preview, selected, t]);

  const toggle = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const { value: id, checked } = event.currentTarget;
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);
  const toggleAll = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setSelected(
        new Set(
          event.currentTarget.checked
            ? eligible.map((candidate) => candidate.id)
            : []
        )
      );
    },
    [eligible]
  );
  const enter = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        inspect();
      }
    },
    [inspect]
  );

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="skill-install-url">
            {t("skills.installFromLinkTitle")}
          </FieldLabel>
          <FieldDescription>
            {t("skills.installFromLinkDescription")}
          </FieldDescription>
          <div className="flex gap-2">
            <Input
              disabled={phase !== null}
              id="skill-install-url"
              inputMode="url"
              onChange={changeUrl}
              onKeyDown={enter}
              placeholder={t("skills.installLinkPlaceholder")}
              value={url}
            />
            <Button disabled={phase !== null || !recognized} onClick={inspect}>
              {phase === "preview"
                ? t("skills.inspecting")
                : t("skills.inspectLink")}
            </Button>
          </div>
          <p
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            {recognized ? (
              <>
                <CheckCircle2Icon className="size-3.5 shrink-0" />
                {t("skills.linkRecognized", {
                  type: t(
                    recognized.kind === "github-repo"
                      ? "skills.linkTypeGithubRepo"
                      : "skills.linkTypeZip"
                  ),
                })}
              </>
            ) : url.trim() ? (
              t("skills.linkTypeUnrecognized")
            ) : (
              t("skills.installLinkHint")
            )}
          </p>
        </Field>
      </FieldGroup>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <>
          <fieldset
            className="flex min-h-0 flex-col gap-3"
            disabled={phase !== null}
          >
            <legend className="mb-2 text-sm font-medium">
              {t("skills.discoveredSkills", {
                count: preview.candidates.length,
              })}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={
                  eligible.length > 0 && selected.size === eligible.length
                }
                className="size-4 accent-primary"
                disabled={!eligible.length || phase !== null}
                onChange={toggleAll}
                type="checkbox"
              />
              {t("skills.selectAllInstallable")}
            </label>
            <div className="max-h-[35dvh] overflow-y-auto rounded-xl border border-border">
              {preview.candidates.map((candidate) => {
                const result = results.find((item) => item.id === candidate.id);
                return (
                  <label
                    className="flex items-start gap-3 border-b border-border p-3 last:border-b-0"
                    key={candidate.id}
                  >
                    <input
                      aria-label={t("skills.selectSkill", {
                        name: candidate.name,
                      })}
                      checked={selected.has(candidate.id)}
                      className="mt-1 size-4 shrink-0 accent-primary"
                      disabled={Boolean(candidate.issue) || phase !== null}
                      onChange={toggle}
                      type="checkbox"
                      value={candidate.id}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="break-all text-sm font-medium">
                        {candidate.name}
                      </span>
                      <span className="break-words text-xs text-muted-foreground">
                        {candidate.description}
                      </span>
                      <span className="break-all font-mono text-xs text-muted-foreground">
                        {candidate.path}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("skills.skillCandidateSize", {
                          count: candidate.fileCount,
                          size: (candidate.totalBytes / 1024 / 1024).toFixed(2),
                        })}
                      </span>
                      {result?.status === "installed" ? (
                        <span className="text-xs" role="status">
                          {t("skills.installed")}
                        </span>
                      ) : candidate.issue ? (
                        <span className="text-xs text-muted-foreground">
                          {t(`skills.installIssues.${candidate.issue}`, {
                            count: SKILL_LIMITS.files,
                            maxMB:
                              candidate.issue === "fileSize"
                                ? SKILL_LIMIT_MB.file
                                : SKILL_LIMIT_MB.total,
                          })}
                        </span>
                      ) : result?.status === "failed" ? (
                        <span
                          className="text-xs text-destructive"
                          role="status"
                        >
                          {t("skills.installItemFailed")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {t("skills.previewExpiryHint")}
          </p>
          <Button disabled={phase !== null || !selected.size} onClick={install}>
            {phase === "install"
              ? t("skills.installing")
              : t("skills.installSelected", { count: selected.size })}
          </Button>
        </>
      ) : null}
    </div>
  );
}
