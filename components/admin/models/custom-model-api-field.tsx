"use client";

import { useCallback } from "react";
import { usePreferences } from "@/components/preferences-provider";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CustomModelApi,
  customModelApiSchema,
} from "@/lib/admin/custom-models";

export function CustomModelApiField({
  value,
  onChange,
  disabled,
}: {
  value: CustomModelApi;
  onChange: (value: CustomModelApi) => void;
  disabled?: boolean;
}) {
  const { t } = usePreferences();
  const change = useCallback(
    (next: string) => onChange(customModelApiSchema.parse(next)),
    [onChange]
  );
  return (
    <div className="grid gap-2">
      <Label htmlFor="custom-model-api">{t("modelPlugins.customApi")}</Label>
      <Select disabled={disabled} onValueChange={change} value={value}>
        <SelectTrigger className="w-full" id="custom-model-api">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anthropic-messages">
            {t("modelPlugins.customApiAnthropic")}
          </SelectItem>
          <SelectItem value="openai-completions">
            {t("modelPlugins.customApiChat")}
          </SelectItem>
          <SelectItem value="openai-responses">
            {t("modelPlugins.customApiResponses")}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
