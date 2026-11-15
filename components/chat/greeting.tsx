"use client";

import { motion } from "motion/react";
import { PiLogo } from "@/components/auth/pi-logo";
import { usePreferences } from "@/components/preferences-provider";

export const Greeting = () => {
  const { t } = usePreferences();

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-3.5 px-4 select-none"
      initial={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <PiLogo className="size-11 opacity-50" />
      <div className="text-center text-[22px] font-normal text-foreground">
        {t("chat.confirmWhatShouldWeWorkOn")}
      </div>
    </motion.div>
  );
};
