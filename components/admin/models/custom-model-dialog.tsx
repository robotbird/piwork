// biome-ignore-all lint/performance/noJsxPropsBind: form controls bind their local state setters

"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { usePreferences } from "@/components/preferences-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { CustomModelApi } from "@/lib/admin/custom-models";
import { CustomModelApiField } from "./custom-model-api-field";

export function CustomModelDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = usePreferences();
  const [api, setApi] = useState<CustomModelApi>("openai-completions");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [visible, setVisible] = useState(false);
  const [vision, setVision] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [toolCall, setToolCall] = useState(true);
  const [contextWindow, setContextWindow] = useState("128000");
  const [maxTokens, setMaxTokens] = useState("8192");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  async function submit(testOnly: boolean) {
    setBusy(testOnly ? "test" : "save");
    try {
      const response = await fetch("/api/admin/model-plugins/custom", {
        body: JSON.stringify({
          api,
          apiKey,
          contextWindow: Number(contextWindow),
          endpoint,
          maxTokens: Number(maxTokens),
          modelId,
          reasoning,
          testOnly,
          toolCall,
          vision,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        toast.error(t(body.error ?? "modelPlugins.customConnectionFailed"));
        return;
      }
      toast.success(
        t(
          testOnly ? "modelPlugins.customConnected" : "modelPlugins.customSaved"
        )
      );
      if (!testOnly) {
        onOpenChange(false);
        await onSaved();
      }
    } catch {
      toast.error(t("admin.networkErrorTryAgainLater"));
    } finally {
      setBusy(null);
    }
  }
  const disabled =
    !!busy || !endpoint.trim() || !apiKey.trim() || !modelId.trim();
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!busy) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{t("modelPlugins.customAdd")}</DialogTitle>
          <DialogDescription>
            {t("modelPlugins.customDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 overflow-y-auto px-6 pb-6">
          <CustomModelApiField
            disabled={!!busy}
            onChange={setApi}
            value={api}
          />
          <div className="grid gap-2">
            <Label htmlFor="custom-endpoint">
              {t("modelPlugins.customEndpoint")}
            </Label>
            <Input
              id="custom-endpoint"
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={
                api === "anthropic-messages"
                  ? "https://api.example.com"
                  : "https://api.example.com/v1"
              }
              value={endpoint}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                api === "anthropic-messages"
                  ? "modelPlugins.customAnthropicEndpointHint"
                  : "modelPlugins.customEndpointHint"
              )}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="custom-api-key">
              {t("modelPlugins.customApiKey")}
            </Label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  autoComplete="off"
                  className="pr-10"
                  id="custom-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  type={visible ? "text" : "password"}
                  value={apiKey}
                />
                <Button
                  aria-label={t(
                    visible
                      ? "modelPlugins.customHideKey"
                      : "modelPlugins.customShowKey"
                  )}
                  className="absolute top-0 right-0"
                  onClick={() => setVisible(!visible)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  {visible ? (
                    <EyeOffIcon className="size-4" />
                  ) : (
                    <EyeIcon className="size-4" />
                  )}
                </Button>
              </div>
              <Button
                disabled={disabled}
                onClick={() => submit(true)}
                variant="outline"
              >
                {busy === "test" ? <Spinner /> : null}
                {t("modelPlugins.customTest")}
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="custom-model-id">
              {t("modelPlugins.customModelId")}
            </Label>
            <Input
              id="custom-model-id"
              onChange={(event) => setModelId(event.target.value)}
              placeholder={t("modelPlugins.customModelPlaceholder")}
              value={modelId}
            />
          </div>
          <fieldset className="grid gap-4">
            <legend className="mb-3 text-sm font-medium">
              {t("modelPlugins.customAdvanced")}
            </legend>
            <div className="flex flex-wrap gap-5">
              {(
                [
                  { key: "tools", set: setToolCall, value: toolCall },
                  { key: "vision", set: setVision, value: vision },
                  { key: "reasoning", set: setReasoning, value: reasoning },
                ] as const
              ).map((field) => (
                <Label className="flex items-center gap-2" key={field.key}>
                  <Switch checked={field.value} onCheckedChange={field.set} />
                  {t(`modelPlugins.${field.key}`)}
                </Label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="custom-context">
                  {t("modelPlugins.customContext")}
                </Label>
                <Input
                  id="custom-context"
                  min={1}
                  onChange={(event) => setContextWindow(event.target.value)}
                  type="number"
                  value={contextWindow}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="custom-output">
                  {t("modelPlugins.customOutput")}
                </Label>
                <Input
                  id="custom-output"
                  min={1}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  type="number"
                  value={maxTokens}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("modelPlugins.customLimitsHint")}
            </p>
          </fieldset>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button
            disabled={!!busy}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {t("common.cancel")}
          </Button>
          <Button disabled={disabled} onClick={() => submit(false)}>
            {busy === "save" ? <Spinner /> : null}
            {t("admin.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
