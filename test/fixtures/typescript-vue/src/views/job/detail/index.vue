<script setup lang="ts">
declare function ref<T>(value: T): { value: T };
declare function fetchJobDetail(id: string): Promise<unknown>;
const loading = ref(false);
void fetchJobDetail('job-1');
</script>
<template><section class="page">Job detail</section></template>
<style scoped>.page { display: block; }</style>
