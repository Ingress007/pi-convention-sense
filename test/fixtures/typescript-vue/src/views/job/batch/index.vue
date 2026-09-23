<script setup lang="ts">
declare function ref<T>(value: T): { value: T };
declare function fetchJobList(params: object): Promise<unknown>;
const loading = ref(false);
void fetchJobList({ page: 1 });
</script>
<template><section class="page">Jobs</section></template>
<style scoped>.page { display: block; }</style>
