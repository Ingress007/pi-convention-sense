import { request } from '../request';
export function fetchJobList(params: object) { return request({ url: '/jobs', params }); }
export function fetchJobDetail(id: string) { return request({ url: `/jobs/${id}` }); }
