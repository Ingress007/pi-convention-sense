import { request } from '../request';
export function fetchTaskList(params: object) { return request({ url: '/tasks', params }); }
export function fetchTaskDetail(id: string) { return request({ url: `/tasks/${id}` }); }
