import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyExecution } from "../../../lib/ai/execution-classifier";
import { projectChatExecution } from "../../../lib/runtime/backends/routing/chat-routing";

test("chat classification selects workspace execution for tool requests and attachments", async () => {
  for (const [message, attachmentCount, expected] of [
    ["你好", 0, false],
    ["请执行 bash 命令生成 hello.txt 并交付下载", 0, true],
    ["请处理附件", 1, true],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: three independent routing assertions, not a load test
    const decision = await classifyExecution(
      { attachmentCount, history: [], message },
      { modelRef: "" }
    );
    assert.equal(decision.requiresExecution, expected, message);
  }
});

test("project execution is required and missing sandbox or disabled tools fails closed", () => {
  for (const sandboxProvider of ["docker", "opensandbox"]) {
    assert.deepEqual(
      projectChatExecution({
        executionEnabled: true,
        projectChat: true,
        sandboxProvider,
      }),
      { reason: "project-sandbox", requiresExecution: true }
    );
  }
  assert.equal(
    projectChatExecution({ executionEnabled: false, projectChat: false }),
    null
  );
  assert.throws(() =>
    projectChatExecution({
      executionEnabled: false,
      projectChat: true,
      sandboxProvider: "docker",
    })
  );
  for (const sandboxProvider of [undefined, "", "invalid"]) {
    assert.throws(() =>
      projectChatExecution({
        executionEnabled: true,
        projectChat: true,
        sandboxProvider,
      })
    );
  }
});
