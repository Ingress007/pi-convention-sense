const axios = { create: (config: object) => config };
export const adminClient = axios.create({ baseURL: '/workspace-admin' });
