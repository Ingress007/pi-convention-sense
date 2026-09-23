declare function defineStore<T>(id: string, setup: () => T): () => T;
declare function ref<T>(value: T): { value: T };
export const useThemeStore = defineStore('theme', () => {
  const dark = ref(false);
  return { dark };
});
