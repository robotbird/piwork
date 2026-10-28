import {
  loadManagedProjectSkillSummaries,
  registerManagedProjectSkill,
} from "@/lib/ai/managed-skills";
import {
  deleteProjectSkill,
  downloadSkillInstallArchive,
  installProjectSkill,
} from "@/lib/ai/skills";
import { SkillInstallationService } from "./skill-installation";

const scope = globalThis as typeof globalThis & {
  piworkSkillInstallationService?: SkillInstallationService;
};

/** Shared across route bundles/HMR. Restart or expiry requires a fresh preview. */
export function getSkillInstallationService() {
  scope.piworkSkillInstallationService ??= new SkillInstallationService({
    download: downloadSkillInstallArchive,
    existingNames: async () => {
      const { skills } = await loadManagedProjectSkillSummaries();
      return new Set(skills.map((skill) => skill.name));
    },
    install: (files) => installProjectSkill({ files }),
    register: (name, actor) =>
      registerManagedProjectSkill({ name, uploadedBy: actor }),
    remove: deleteProjectSkill,
  });
  return scope.piworkSkillInstallationService;
}
