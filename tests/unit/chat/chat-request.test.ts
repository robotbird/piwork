import assert from "node:assert/strict";
import test from "node:test";
import { postRequestBodySchema } from "../../../app/(chat)/api/chat/schema";
import { isChatApprovalContinuation } from "../../../hooks/chat-request";
import type { ChatMessage } from "../../../lib/types";

test("new user turns ignore old approval states; assistant continuations remain approvals", () => {
  const history: ChatMessage = {
    id: crypto.randomUUID(),
    parts: [{ state: "approval-responded", type: "dynamic-tool" } as never],
    role: "assistant",
  };
  const fresh: ChatMessage = {
    id: crypto.randomUUID(),
    parts: [{ text: "fresh", type: "text" }],
    role: "user",
  };
  assert.equal(isChatApprovalContinuation([history, fresh]), false);
  assert.equal(isChatApprovalContinuation([history]), true);
});

const request = {
  id: crypto.randomUUID(),
  message: {
    id: crypto.randomUUID(),
    parts: [{ text: "hello", type: "text" }],
    role: "user",
  },
  selectedChatModel: "test",
  selectedVisibilityType: "private",
};
test("chat requests strip client-supplied backend, project grant and identity", () => {
  const parsed = postRequestBodySchema.parse({
    ...request,
    projectSources: { projectId: crypto.randomUUID() },
    runtimeLane: "in_process",
    userId: crypto.randomUUID(),
  });
  assert.deepEqual(parsed, request);
});

test("the request schema accepts an approval continuation without a new message", () => {
  assert.ok(
    postRequestBodySchema.safeParse({
      ...request,
      message: undefined,
      messages: [],
    }).success
  );
});
