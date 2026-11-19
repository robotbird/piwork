import { NextIntlClientProvider } from "next-intl";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { ChatHeader } from "../../components/chat/chat-header";
import { DataStreamProvider } from "../../components/chat/data-stream-provider";
import { MultimodalInput } from "../../components/chat/multimodal-input";
import { SidebarHistory } from "../../components/chat/sidebar-history";
import { PreferencesProvider } from "../../components/preferences-provider";
import { SidebarProvider } from "../../components/ui/sidebar";
import { ActiveChatProvider, useActiveChat } from "../../hooks/use-active-chat";
import en from "../../i18n/messages/en.json";
import zh from "../../i18n/messages/zh.json";
import type { Attachment } from "../../lib/types";

function Preview() {
  const chat = useActiveChat();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const handleNewChat = useCallback(
    () => window.history.pushState({}, "", "/"),
    []
  );
  return (
    <>
      <SidebarHistory user={{ id: "fixture-user", type: "regular" }} />
      <button onClick={handleNewChat} type="button">
        新对话
      </button>
      <ChatHeader
        chatId={chat.chatId}
        hasMessages={chat.messages.length > 0}
        isReadonly={chat.isReadonly}
        selectedVisibilityType="private"
        title="测试对话"
      />
      <MultimodalInput
        attachments={attachments}
        chatId={chat.chatId}
        input={chat.input}
        messages={chat.messages}
        selectedModelId={chat.currentModelId}
        selectedVisibilityType="private"
        sendMessage={chat.sendMessage}
        setAttachments={setAttachments}
        setInput={chat.setInput}
        setMessages={chat.setMessages}
        status={chat.status}
        stop={chat.stop}
      />
      <output data-testid="status">{chat.status}</output>
      <div data-testid="messages">
        {chat.messages.map((message) => (
          <p key={message.id}>
            {message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")}
          </p>
        ))}
      </div>
    </>
  );
}

function LocalePreview() {
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const selectEnglish = useCallback(() => setLocale("en"), []);
  const selectChinese = useCallback(() => setLocale("zh"), []);
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : zh}
    >
      <PreferencesProvider>
        <button onClick={selectEnglish} type="button">
          English
        </button>
        <button onClick={selectChinese} type="button">
          中文
        </button>
        <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
          <SidebarProvider>
            <DataStreamProvider>
              <ActiveChatProvider>
                <Preview />
              </ActiveChatProvider>
            </DataStreamProvider>
          </SidebarProvider>
        </SWRConfig>
      </PreferencesProvider>
    </NextIntlClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Preview root is missing");
}
createRoot(root).render(<LocalePreview />);
