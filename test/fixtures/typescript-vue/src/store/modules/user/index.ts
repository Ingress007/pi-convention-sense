declare function defineStore<T>(id: string, setup: () => T): () => T;
declare function ref<T>(value: T): { value: T };
export const useUserStore = defineStore('user', () => {
  const name = ref('');
  return { name };
});
