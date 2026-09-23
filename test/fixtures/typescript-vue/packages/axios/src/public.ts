const axios = { create: (config: object) => config };
export const publicClient = axios.create({ baseURL: '/workspace-public' });
