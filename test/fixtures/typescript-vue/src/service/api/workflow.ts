import { request } from '../request';
export function fetchWorkflowList(params: object) { return request({ url: '/workflows', params }); }
export function fetchWorkflowDetail(id: string) { return request({ url: `/workflows/${id}` }); }
