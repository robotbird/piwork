import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { desktopInferenceUsage } from "./schema";

export async function createDesktopInferenceUsage(
  userId: string,
  runId: string
) {
  const [record] = await getDb()
    .insert(desktopInferenceUsage)
    .values({ runId, userId })
    .returning({ id: desktopInferenceUsage.id });
  if (!record) {
    throw new Error("Unable to record desktop inference");
  }
  return record.id;
}
export async function finishDesktopInferenceUsage(
  id: string,
  usage: { input: number; output: number; totalTokens: number }
) {
  await getDb()
    .update(desktopInferenceUsage)
    .set({
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
    })
    .where(eq(desktopInferenceUsage.id, id));
}
