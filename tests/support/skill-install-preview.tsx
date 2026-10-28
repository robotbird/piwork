import { NextIntlClientProvider } from "next-intl";
import { createRoot } from "react-dom/client";
import { AdminSkillManager } from "../../components/admin/admin-skill-manager";
import { PreferencesProvider } from "../../components/preferences-provider";
import messages from "../../i18n/messages/zh.json";

// 隔离预览：不访问真实身份/DB/模型；API 由 e2e 脚本 route mock 提供。
const root = document.getElementById("root");
if (!root) {
  throw new Error("Preview root is missing");
}
createRoot(root).render(
  <NextIntlClientProvider locale="zh" messages={messages}>
    <PreferencesProvider>
      <AdminSkillManager
        initialSkills={[
          {
            description: "整理零散会议记录并产出可分发纪要。",
            displayName: "会议纪要",
            enabled: true,
            name: "meeting-notes",
            source: "upload",
            version: "1.0.0",
          },
        ]}
      />
    </PreferencesProvider>
  </NextIntlClientProvider>
);
