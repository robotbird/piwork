import { FileIcon, FileTextIcon, WorkflowIcon } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";

const iconExtensions = {
  excel: ["xls", "xlsx", "xlsm", "ods", "csv"],
  pdf: ["pdf"],
  powerpoint: ["ppt", "pptx", "pptm", "odp"],
  word: ["doc", "docx", "docm", "odt", "rtf"],
} as const;

const iconMediaTypes = {
  excel: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
  ],
  pdf: ["application/pdf"],
  powerpoint: [
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.presentation",
  ],
  word: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
    "application/rtf",
  ],
} as const;

export function FileTypeIcon({
  filename,
  contentType,
  className,
  fallback,
}: {
  filename?: string | null;
  contentType?: string | null;
  className?: string;
  fallback?: ReactNode;
}) {
  const extension = filename?.split(".").at(-1)?.toLowerCase() ?? "";
  const mediaType = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  const types = Object.keys(iconExtensions) as (keyof typeof iconExtensions)[];
  const icon =
    types.find((type) =>
      (iconExtensions[type] as readonly string[]).includes(extension)
    ) ??
    types.find((type) =>
      (iconMediaTypes[type] as readonly string[]).includes(mediaType)
    );

  if (icon) {
    return (
      <Image
        alt=""
        aria-hidden="true"
        className={className}
        height={32}
        src={`/images/file-types/${icon}.svg`}
        unoptimized
        width={32}
      />
    );
  }

  if (fallback) {
    return fallback;
  }

  const Icon =
    extension === "drawio"
      ? WorkflowIcon
      : ["txt", "md"].includes(extension)
        ? FileTextIcon
        : FileIcon;
  return <Icon aria-hidden="true" className={className} />;
}
