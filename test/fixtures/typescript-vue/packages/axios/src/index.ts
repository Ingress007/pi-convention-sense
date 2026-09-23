const axios = { create: (config: object) => config };
export const requestClient = axios.create({ baseURL: '/workspace-api' });
