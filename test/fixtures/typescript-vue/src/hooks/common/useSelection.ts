declare function ref<T>(value: T): { value: T };
declare function computed<T>(factory: () => T): { value: T };
export function useSelection() {
  const selected = ref<string[]>([]);
  const count = computed(() => selected.value.length);
  return { selected, count };
}
