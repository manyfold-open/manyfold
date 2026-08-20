import { getNetmindConfig } from './config'

const encodeForm = (data: Record<string, unknown>): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(data))
        if (value !== undefined && value !== null)
            params.append(key, String(value))
    return params.toString()
}

// POST to NetMind's auth API (application/x-www-form-urlencoded) and unwrap the
// {success,data,msg} envelope, rejecting on success:false.
export const netmindPost = async <T = unknown>(
    path: string,
    body: Record<string, unknown>
): Promise<T> => {
    const { authApi } = getNetmindConfig()
    const resp = await fetch(`${authApi}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm(body)
    })
    const json = (await resp.json()) as {
        success?: boolean
        data?: T
        msg?: string
    }
    if (json?.success === false)
        throw new Error(json.msg || 'NetMind request failed')
    return json.data as T
}