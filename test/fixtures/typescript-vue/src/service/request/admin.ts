const axios = { create: (config: object) => config };
export const adminRequest = axios.create({ baseURL: '/api/admin' });
