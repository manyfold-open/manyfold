import { getNetmindConfig } from './config'

// Common params NetMind's auth API expects on every request.
export const baseRequestParams = (): Record<string, string | number> => ({
    deviceId: 123231,
    clientType: 5,
    clientVersion: '1.0.0',
    sysCode: getNetmindConfig().sysCode
})