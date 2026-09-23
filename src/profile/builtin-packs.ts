import type { ConventionPack } from "./types.js";

export const BUILTIN_CONVENTION_PACKS: readonly ConventionPack[] = [
  {
    schemaVersion: 1,
    id: "java-spring",
    version: "1.0.0",
    kind: "framework",
    title: "Java Spring baseline",
    description: "Advisory Spring application baseline used only when enabled by a Project Profile.",
    languages: ["java"],
    detection: [
      {
        kind: "dependency",
        pattern: "org.springframework",
        weight: 10,
        description: "Spring dependencies in Maven or Gradle manifests",
      },
    ],
    conventions: [
      {
        id: "spring-controller-boundary",
        category: "controller-boundary",
        statement: "Keep MVC view controllers and REST controllers in distinct effective roles when the project exposes both.",
        strength: "advisory",
        selector: { languages: ["java"], baseRoles: ["controller"] },
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "typescript-vue",
    version: "1.0.0",
    kind: "framework",
    title: "TypeScript Vue baseline",
    description: "Advisory Vue and TypeScript application baseline used only when enabled by a Project Profile.",
    languages: ["typescript", "vue"],
    detection: [
      {
        kind: "dependency",
        pattern: "vue",
        weight: 10,
        description: "Vue dependency in package.json",
      },
    ],
    conventions: [
      {
        id: "vue-role-boundaries",
        category: "role-boundary",
        statement: "Keep route pages, components, hooks, stores, routers, API services, request clients, layouts, and workspace packages as separate evidence roles.",
        strength: "advisory",
        selector: { languages: ["typescript", "vue"] },
      },
    ],
  },
] as const;
