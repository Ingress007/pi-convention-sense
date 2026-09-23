declare function ref<T>(value: T): { value: T };
declare function computed<T>(factory: () => T): { value: T };
export function usePagination() {
  const page = ref(1);
  const offset = computed(() => page.value - 1);
  return { page, offset };
}
