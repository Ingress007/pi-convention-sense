const axios = { create: (config: object) => config };
export const publicRequest = axios.create({ baseURL: '/api/public' });
