export type ChatModelCatalog = {
  defaultModelId: string | null;
  models: { id: string }[];
};

/** Resolve only against the member's current authorized catalog. */
export function resolveChatModelId(
  catalog: ChatModelCatalog | undefined,
  preferredId: string
): string | null {
  // 目录载荷必须完整才可信：异常响应（如重启窗口期的错误 JSON）可能 2xx 但缺
  // models 字段，按"目录未就绪"处理，避免白屏整个聊天布局。
  if (!catalog || !Array.isArray(catalog.models)) {
    return null;
  }
  if (catalog.models.some((model) => model.id === preferredId)) {
    return preferredId;
  }
  if (catalog.models.some((model) => model.id === catalog.defaultModelId)) {
    return catalog.defaultModelId;
  }
  return catalog.models[0]?.id ?? null;
}
