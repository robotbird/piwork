import { auth } from "@/app/(auth)/auth";
import { loadManagedProjectSkillSummaries } from "@/lib/ai/managed-skills";
import { listProjectSkillFiles, readProjectSkillFile } from "@/lib/ai/skills";
import { ChatbotError } from "@/lib/errors";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const { name } = await params;
  const filePath = new URL(request.url).searchParams.get("path");

  try {
    const { skills } = await loadManagedProjectSkillSummaries({
      enabledOnly: true,
    });
    if (!skills.some((skill) => skill.name === name)) {
      return Response.json(
        { error: `Enabled skill "${name}" was not found.` },
        { headers: NO_STORE_HEADERS, status: 404 }
      );
    }
    if (filePath === null) {
      const { entries } = await listProjectSkillFiles(name);
      return Response.json({ entries }, { headers: NO_STORE_HEADERS });
    }

    const file = await readProjectSkillFile(name, filePath);
    return Response.json({ file }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read skill files";
    return Response.json(
      { error: message },
      {
        headers: NO_STORE_HEADERS,
        status: message.includes("was not found") ? 404 : 400,
      }
    );
  }
}
