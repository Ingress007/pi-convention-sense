<script setup lang="ts">
declare function ref<T>(value: T): { value: T };
declare function fetchTaskList(params: object): Promise<unknown>;
const loading = ref(false);
void fetchTaskList({ page: 1 });
</script>
<template><section class="page">Tasks</section></template>
<style scoped>.page { display: block; }</style>
