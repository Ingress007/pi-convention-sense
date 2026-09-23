const axios = { create: (config: object) => config };
export const request = axios.create({ baseURL: '/api' });
