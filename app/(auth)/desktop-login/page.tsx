import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/app/(auth)/auth";
import { AuthFrame } from "@/components/auth/auth-frame";
import { desktopSecretPattern } from "@/lib/auth/desktop-login-return";
import { DesktopLogin } from "./desktop-login";

export const metadata: Metadata = { referrer: "no-referrer" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await auth();
  if (!session?.user) {
    redirect(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/login`);
  }
  const state = typeof params.state === "string" ? params.state : "";
  const challenge =
    typeof params.challenge === "string" ? params.challenge : "";
  return (
    <AuthFrame>
      <DesktopLogin
        challenge={challenge}
        identity={session.user.email ?? session.user.name ?? ""}
        state={state}
        valid={
          desktopSecretPattern.test(state) &&
          desktopSecretPattern.test(challenge)
        }
      />
    </AuthFrame>
  );
}
