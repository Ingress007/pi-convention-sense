declare function defineStore<T>(id: string, setup: () => T): () => T;
declare function ref<T>(value: T): { value: T };
export const useAppStore = defineStore('app', () => {
  const ready = ref(false);
  return { ready };
});
